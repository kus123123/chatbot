const { GoogleGenAI } = require("@google/genai");

const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const FILE_UPLOAD_POLL_INTERVAL_MS = 5000;
const FILE_UPLOAD_MAX_ATTEMPTS = 36;
const DEFAULT_SUGGESTION_COUNT = Number(process.env.SUGGESTION_COUNT) || 6;

let aiClient;

function getApiKey() {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is missing. Add it to .env.");
  }

  return apiKey;
}

function getAiClient() {
  if (!aiClient) {
    aiClient = new GoogleGenAI({ apiKey: getApiKey() });
  }

  return aiClient;
}

async function createFileSearchStore(displayName) {
  const ai = getAiClient();

  const fileSearchStore = await ai.fileSearchStores.create({
    config: {
      displayName: displayName || `monitoring-store-${Date.now()}`,
    },
  });

  return fileSearchStore;
}

async function waitForOperation(operation) {
  const ai = getAiClient();
  let activeOperation = operation;

  for (let attempt = 0; attempt < FILE_UPLOAD_MAX_ATTEMPTS; attempt += 1) {
    if (activeOperation.done) {
      return activeOperation;
    }

    await new Promise((resolve) => setTimeout(resolve, FILE_UPLOAD_POLL_INTERVAL_MS));
    activeOperation = await ai.operations.get({ operation: activeOperation });
  }

  throw new Error("File upload is still processing. Please retry in a few moments.");
}

async function uploadFileToStore({
  filePath,
  fileSearchStoreName,
  displayName,
  mimeType,
  waitForCompletion = false,
}) {
  const ai = getAiClient();

  if (!fileSearchStoreName) {
    throw new Error("fileSearchStoreName is required to upload a file.");
  }

  let operation = await ai.fileSearchStores.uploadToFileSearchStore({
    file: filePath,
    fileSearchStoreName,
    config: {
      displayName: displayName || "monitoring-data",
      ...(mimeType ? { mimeType } : {}),
    },
  });

  if (waitForCompletion) {
    operation = await waitForOperation(operation);
  }

  return operation;
}

function normalizeOperationError(error) {
  if (!error) {
    return null;
  }

  if (typeof error === "string") {
    return error;
  }

  if (typeof error.message === "string" && error.message.trim()) {
    return error.message.trim();
  }

  if (typeof error.details === "string" && error.details.trim()) {
    return error.details.trim();
  }

  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown operation error";
  }
}

function inProgressStatusFromMetadata(metadata) {
  const text = JSON.stringify(metadata || {}).toLowerCase();
  if (text.includes("pending") || text.includes("queue")) {
    return "pending";
  }

  return "running";
}

async function getUploadOperationStatus({ operationName }) {
  const trimmedName = String(operationName || "").trim();
  if (!trimmedName) {
    throw new Error("operationName is required.");
  }

  const ai = getAiClient();
  const operation = await ai.operations.get({
    operation: {
      name: trimmedName,
    },
  });

  const done = Boolean(operation?.done);
  const error = normalizeOperationError(operation?.error);

  let status = inProgressStatusFromMetadata(operation?.metadata);
  if (done) {
    status = error ? "failed" : "completed";
  }

  return {
    status,
    done,
    error,
    operationName: String(operation?.name || trimmedName),
  };
}

function buildSystemInstruction(sourceLinks) {
  const hasSourceLinks = sourceLinks.length > 0;
  const linkList = sourceLinks.map((link, index) => `${index + 1}. ${link}`).join("\n");

  return [
    "You are an expert realtime monitoring analyst.",
    "Do not hallucinate, fabricate, or infer unsupported facts.",
    "Never alter user-provided numeric data.",
    "If evidence is missing, return: Insufficient verified data for this request.",
    "Every factual statement must be grounded in provided sources or file-search evidence.",
    "For ranked/list outputs with numeric values (for example AQI city ranking), return a markdown table sorted by the requested order.",
    "For AQI-style rankings, prefer columns: Rank | Location | AQI | Category | Date | Evidence.",
    hasSourceLinks
      ? "Include a Sources section with exact links provided below."
      : "If external source links are not provided, rely only on file-search evidence. If insufficient evidence exists, return the exact insufficiency message.",
    "Source links:",
    linkList || "None",
  ].join("\n");
}

async function generateAnswerWithFileSearch({
  prompt,
  fileSearchStoreName,
  sourceLinks,
  model = DEFAULT_MODEL,
}) {
  const ai = getAiClient();

  const tools = [];
  if (fileSearchStoreName) {
    tools.push({
      fileSearch: {
        fileSearchStoreNames: [fileSearchStoreName],
      },
    });
  }

  const response = await ai.models.generateContent({
    model,
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ],
    config: {
      temperature: 0.1,
      ...(tools.length > 0 ? { tools } : {}),
      systemInstruction: buildSystemInstruction(sourceLinks || []),
    },
  });

  const text = (response.text || "").trim();
  if (!text) {
    throw new Error("Gemini returned an empty response.");
  }

  return {
    text,
    rawResponse: response,
  };
}

function fallbackSuggestedQuestions() {
  return [
    "Which 5 entities currently have the highest values, and what evidence supports each rank?",
    "Which metrics show the largest week-over-week or period-over-period increase?",
    "Which rows look like statistical outliers or anomaly candidates that need investigation?",
    "Where do actual values exceed expected or threshold values most significantly?",
    "Which segments are deteriorating fastest, and what pattern suggests operational risk?",
    "Which entities improved most recently, and which metric drove that change?",
  ];
}

function sanitizeQuestionText(value) {
  const normalized = String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^[-*0-9.)\s]+/, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();

  if (!normalized) {
    return "";
  }

  const withoutTrailingPunctuation = normalized.replace(/[.!]+$/g, "").trim();
  if (!withoutTrailingPunctuation) {
    return "";
  }

  return withoutTrailingPunctuation.endsWith("?")
    ? withoutTrailingPunctuation
    : `${withoutTrailingPunctuation}?`;
}

function finalizeSuggestedQuestions(candidates, count) {
  const unique = new Set();
  const questions = [];

  for (const candidate of candidates || []) {
    const cleaned = sanitizeQuestionText(candidate);
    if (!cleaned) {
      continue;
    }

    if (cleaned.length < 20) {
      continue;
    }

    if (/insufficient verified data/i.test(cleaned) || /^sources?$/i.test(cleaned)) {
      continue;
    }

    const key = cleaned.toLowerCase();
    if (unique.has(key)) {
      continue;
    }

    unique.add(key);
    questions.push(cleaned);

    if (questions.length >= count) {
      break;
    }
  }

  return questions;
}

function parseSuggestedQuestions(rawText, count) {
  const trimmed = String(rawText || "").trim();
  if (!trimmed) {
    return [];
  }

  const normalized = trimmed
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    const parsed = JSON.parse(normalized);
    if (Array.isArray(parsed)) {
      return parsed
        .map((value) => String(value || "").trim())
        .filter(
          (value) =>
            !/insufficient verified data/i.test(value) &&
            !/^sources?$/i.test(value),
        )
        .filter(Boolean)
        .slice(0, count);
    }
  } catch {
    const startIndex = normalized.indexOf("[");
    const endIndex = normalized.lastIndexOf("]");
    if (startIndex >= 0 && endIndex > startIndex) {
      try {
        const arrayText = normalized.slice(startIndex, endIndex + 1);
        const parsed = JSON.parse(arrayText);
        if (Array.isArray(parsed)) {
          return parsed
            .map((value) => String(value || "").trim())
            .filter(
              (value) =>
                !/insufficient verified data/i.test(value) &&
                !/^sources?$/i.test(value),
            )
            .filter(Boolean)
            .slice(0, count);
        }
      } catch {
        // Fallback to line parsing.
      }
    }
  }

  return normalized
    .split(/\r?\n/g)
    .map((line) =>
      line
        .replace(/^[-*0-9.\s)]+/, "")
        .replace(/^[`"\[]+/, "")
        .replace(/[,\]`"]+$/, "")
        .trim(),
    )
    .filter(
      (line) => !/insufficient verified data/i.test(line) && !/^sources?$/i.test(line),
    )
    .filter(Boolean)
    .slice(0, count);
}

async function generateSuggestedQuestions({
  fileSearchStoreName,
  sourceLinks = [],
  count = DEFAULT_SUGGESTION_COUNT,
  model = DEFAULT_MODEL,
}) {
  const ai = getAiClient();

  const tools = [];
  if (fileSearchStoreName) {
    tools.push({
      fileSearch: {
        fileSearchStoreNames: [fileSearchStoreName],
      },
    });
  }

  const response = await ai.models.generateContent({
    model,
    contents: [
      {
        role: "user",
        parts: [
          {
            text: [
              "Generate high-quality follow-up analysis questions for this uploaded dataset.",
              "Use only available dataset context and file-search evidence.",
              "Questions must be specific and actionable, not generic.",
              "Prioritize ranking, trend shifts, anomaly checks, threshold breaches, and operational risk.",
              "Each question should ask for a concrete cut (top-N, period change, segment comparison, or anomaly criterion).",
              `Return exactly ${count} questions.`,
              "Return output as a JSON array of strings only.",
            ].join("\n"),
          },
        ],
      },
    ],
    config: {
      temperature: 0.2,
      ...(tools.length > 0 ? { tools } : {}),
      systemInstruction: buildSystemInstruction(sourceLinks || []),
    },
  });

  const parsedQuestions = parseSuggestedQuestions(response.text, count * 2);
  const finalized = finalizeSuggestedQuestions(parsedQuestions, count);
  if (finalized.length >= count) {
    return finalized.slice(0, count);
  }

  const fallback = finalizeSuggestedQuestions(fallbackSuggestedQuestions(), count);
  const merged = finalizeSuggestedQuestions([...finalized, ...fallback], count);
  return merged.slice(0, count);
}

module.exports = {
  createFileSearchStore,
  uploadFileToStore,
  getUploadOperationStatus,
  generateAnswerWithFileSearch,
  generateSuggestedQuestions,
};
