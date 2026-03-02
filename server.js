const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const dotenv = require("dotenv");

dotenv.config();
const { createLogger } = require("./logger");

const {
  createFileSearchStore,
  uploadFileToStore,
  getUploadOperationStatus,
  generateAnswerWithFileSearch,
  generateSuggestedQuestions,
} = require("./search");
const { saveChatExchange, getFirestoreStatus } = require("./db-firebase");
const {
  buildDeterministicReport,
  normalizeSourceLinks,
} = require("./monitoring-report");
const {
  listFileSearchStores,
  getFileSearchStoreByName,
  upsertFileSearchStore,
} = require("./store-history");

const logger = createLogger("server");
const PORT = Number(process.env.PORT) || 3000;
const UPLOAD_DIR = path.join(process.cwd(), "tmp-uploads");
const FILE_UPLOAD_MAX_MB = Number(process.env.FILE_UPLOAD_MAX_MB) || 15;

function getCorsOrigins() {
  const originEnv = process.env.CORS_ORIGIN;
  if (!originEnv || !originEnv.trim()) {
    return true;
  }

  return originEnv
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseOptionalData(value, label) {
  if (value == null || value === "") {
    return null;
  }

  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      throw new Error(`${label} must be valid JSON.`);
    }
  }

  if (typeof value === "object") {
    return value;
  }

  throw new Error(`${label} must be an object, array, or JSON string.`);
}

function appendSourcesSection(text, sourceLinks) {
  const clean = (text || "").trim();
  const sourceBlock = sourceLinks.map((link) => `- ${link}`).join("\n");

  if (sourceLinks.length === 0) {
    return clean;
  }

  if (!clean) {
    return `Sources\n${sourceBlock}`;
  }

  if (/\bsources\b/i.test(clean)) {
    return clean;
  }

  return `${clean}\n\nSources\n${sourceBlock}`;
}

function normalizeUploadMimeType(uploadedFile) {
  const original = String(uploadedFile?.mimetype || "").trim().toLowerCase();
  const cleaned = original.split(";")[0].trim();
  const extension = path.extname(uploadedFile?.originalname || "").toLowerCase();

  if (
    extension === ".csv" ||
    cleaned === "text/csv" ||
    cleaned === "application/vnd.ms-excel"
  ) {
    return "text/plain";
  }

  return cleaned || "text/plain";
}

function normalizeOperationError(error) {
  if (!error) {
    return null;
  }

  if (typeof error === "string") {
    return error;
  }

  if (typeof error?.message === "string" && error.message.trim()) {
    return error.message.trim();
  }

  if (typeof error?.details === "string" && error.details.trim()) {
    return error.details.trim();
  }

  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown operation error.";
  }
}

function sendError(res, statusCode, code, message) {
  return res.status(statusCode).json({
    error: {
      code,
      message,
    },
  });
}

function buildIndexingPayload(store, overrides = {}) {
  return {
    status: overrides.status || store.lastUploadStatus || "unknown",
    operationName:
      overrides.operationName || store.lastUploadOperationName || null,
    error:
      Object.prototype.hasOwnProperty.call(overrides, "error")
        ? overrides.error
        : store.lastUploadError || null,
    message: overrides.message || null,
    lastUploadedFileName: store.lastUploadedFileName || null,
    lastUploadedAt: store.lastUploadedAt || null,
    lastCheckedAt: store.lastUploadCheckedAt || null,
    lastCompletedAt: store.lastUploadCompletedAt || null,
  };
}

function createApp(deps = {}) {
  const app = express();

  const loggerInstance = deps.logger || logger;
  const fileUploadMaxMb = Number(deps.fileUploadMaxMb) || FILE_UPLOAD_MAX_MB;
  const uploadDir = deps.uploadDir || UPLOAD_DIR;

  const createFileSearchStoreFn = deps.createFileSearchStore || createFileSearchStore;
  const uploadFileToStoreFn = deps.uploadFileToStore || uploadFileToStore;
  const getUploadOperationStatusFn = deps.getUploadOperationStatus || getUploadOperationStatus;
  const generateAnswerWithFileSearchFn =
    deps.generateAnswerWithFileSearch || generateAnswerWithFileSearch;
  const generateSuggestedQuestionsFn =
    deps.generateSuggestedQuestions || generateSuggestedQuestions;

  const saveChatExchangeFn = deps.saveChatExchange || saveChatExchange;
  const getFirestoreStatusFn = deps.getFirestoreStatus || getFirestoreStatus;

  const buildDeterministicReportFn =
    deps.buildDeterministicReport || buildDeterministicReport;
  const normalizeSourceLinksFn = deps.normalizeSourceLinks || normalizeSourceLinks;

  const listFileSearchStoresFn = deps.listFileSearchStores || listFileSearchStores;
  const getFileSearchStoreByNameFn =
    deps.getFileSearchStoreByName || getFileSearchStoreByName;
  const upsertFileSearchStoreFn = deps.upsertFileSearchStore || upsertFileSearchStore;

  const upload = multer({
    dest: uploadDir,
    limits: {
      fileSize: fileUploadMaxMb * 1024 * 1024,
    },
  });

  function parseLinks(value) {
    return normalizeSourceLinksFn(value);
  }

  app.use(cors({ origin: getCorsOrigins() }));
  app.use(express.json({ limit: "2mb" }));
  app.use((req, res, next) => {
    if (!req.path.startsWith("/api")) {
      return next();
    }

    const requestId = randomUUID();
    const startedAt = Date.now();

    req.requestId = requestId;

    loggerInstance.info("request.start", {
      requestId,
      method: req.method,
      path: req.originalUrl,
      ip: req.ip,
    });

    res.on("finish", () => {
      loggerInstance.info("request.end", {
        requestId,
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt,
      });
    });

    return next();
  });

  app.get("/api/health", (req, res) => {
    loggerInstance.info("health.check", {
      requestId: req.requestId || null,
    });

    res.json({
      ok: true,
      timestamp: new Date().toISOString(),
      uploadMaxMb: fileUploadMaxMb,
      firestore: getFirestoreStatusFn(),
    });
  });

  app.post("/api/file-search/store", async (req, res) => {
    const requestId = req.requestId || null;

    try {
      const displayName = String(req.body?.displayName || "").trim();

      loggerInstance.info("file_search.store.create.start", {
        requestId,
        displayName: displayName || null,
      });

      const store = await createFileSearchStoreFn(displayName);

      try {
        await upsertFileSearchStoreFn({
          fileSearchStoreName: store.name,
          displayName: store.displayName || displayName || store.name,
        });
      } catch (historyError) {
        loggerInstance.warn("file_search.store.history_upsert_failed", {
          requestId,
          fileSearchStoreName: store.name,
          error: historyError.message,
        });
      }

      loggerInstance.info("file_search.store.create.success", {
        requestId,
        fileSearchStoreName: store.name,
        displayName: store.displayName || displayName || null,
      });

      return res.status(201).json({
        fileSearchStoreName: store.name,
        displayName: store.displayName || displayName || null,
      });
    } catch (error) {
      loggerInstance.error("file_search.store.create.failed", {
        requestId,
        error: error.message,
      });

      return sendError(
        res,
        500,
        "INTERNAL_ERROR",
        error.message || "Failed to create file search store.",
      );
    }
  });

  app.get("/api/file-search/stores", async (req, res) => {
    const requestId = req.requestId || null;

    try {
      const limit = req.query?.limit;
      const stores = await listFileSearchStoresFn({ limit });

      loggerInstance.info("file_search.store.list.success", {
        requestId,
        count: stores.length,
      });

      return res.json({
        stores,
      });
    } catch (error) {
      loggerInstance.error("file_search.store.list.failed", {
        requestId,
        error: error.message,
      });

      return sendError(
        res,
        500,
        "INTERNAL_ERROR",
        error.message || "Failed to list file search stores.",
      );
    }
  });

  app.get("/api/file-search/status", async (req, res) => {
    const requestId = req.requestId || null;

    try {
      const fileSearchStoreName = String(req.query?.fileSearchStoreName || "").trim();
      if (!fileSearchStoreName) {
        return sendError(
          res,
          400,
          "VALIDATION_ERROR",
          "fileSearchStoreName query parameter is required.",
        );
      }

      const store = await getFileSearchStoreByNameFn(fileSearchStoreName);
      if (!store) {
        loggerInstance.info("file_search.status.history_missing", {
          requestId,
          fileSearchStoreName,
        });

        return res.json({
          fileSearchStoreName,
          indexing: {
            status: "unknown",
            operationName: null,
            error: null,
            message:
              "Store is not present in local history yet. Upload a file to this store to start indexing tracking.",
            lastUploadedFileName: null,
            lastUploadedAt: null,
            lastCheckedAt: null,
            lastCompletedAt: null,
          },
        });
      }

      if (!store.lastUploadOperationName) {
        return res.json({
          fileSearchStoreName,
          indexing: buildIndexingPayload(store, {
            status: "unknown",
            message: "No upload operation has been recorded for this store yet.",
          }),
        });
      }

      const cachedStatus = store.lastUploadStatus || "unknown";
      if (cachedStatus === "completed" || cachedStatus === "failed") {
        return res.json({
          fileSearchStoreName,
          indexing: buildIndexingPayload(store, {
            status: cachedStatus,
          }),
        });
      }

      loggerInstance.info("file_search.status.check.start", {
        requestId,
        fileSearchStoreName,
        operationName: store.lastUploadOperationName,
      });

      const operationStatus = await getUploadOperationStatusFn({
        operationName: store.lastUploadOperationName,
      });

      await upsertFileSearchStoreFn({
        fileSearchStoreName,
        uploadOperationName: operationStatus.operationName,
        uploadStatus: operationStatus.status,
        uploadError: operationStatus.error,
        markUploadCompleted: operationStatus.status === "completed",
      });

      const refreshedStore = (await getFileSearchStoreByNameFn(fileSearchStoreName)) || store;

      loggerInstance.info("file_search.status.check.success", {
        requestId,
        fileSearchStoreName,
        operationName: operationStatus.operationName,
        status: operationStatus.status,
      });

      return res.json({
        fileSearchStoreName,
        indexing: buildIndexingPayload(refreshedStore, {
          status: operationStatus.status,
          operationName: operationStatus.operationName,
          error: operationStatus.error,
        }),
      });
    } catch (error) {
      loggerInstance.error("file_search.status.check.failed", {
        requestId,
        error: error.message,
      });

      return sendError(
        res,
        502,
        "UPSTREAM_ERROR",
        error.message || "Failed to check file-search upload status.",
      );
    }
  });

  app.post("/api/file-search/upload", upload.single("file"), async (req, res) => {
    const requestId = req.requestId || null;
    const uploadedFile = req.file;

    try {
      const fileSearchStoreName = String(req.body?.fileSearchStoreName || "").trim();
      const displayName = String(req.body?.displayName || uploadedFile?.originalname || "").trim();

      loggerInstance.info("file_search.upload.start", {
        requestId,
        fileSearchStoreName: fileSearchStoreName || null,
        fileName: uploadedFile?.originalname || null,
        mimeType: uploadedFile?.mimetype || null,
        sizeBytes: uploadedFile?.size || null,
      });

      if (!uploadedFile) {
        loggerInstance.warn("file_search.upload.validation_failed", {
          requestId,
          reason: "File is required.",
        });

        return sendError(res, 400, "VALIDATION_ERROR", "File is required.");
      }

      if (!fileSearchStoreName) {
        loggerInstance.warn("file_search.upload.validation_failed", {
          requestId,
          reason: "fileSearchStoreName is required.",
        });

        return sendError(
          res,
          400,
          "VALIDATION_ERROR",
          "fileSearchStoreName is required to upload files.",
        );
      }

      const operation = await uploadFileToStoreFn({
        filePath: uploadedFile.path,
        fileSearchStoreName,
        displayName,
        mimeType: normalizeUploadMimeType(uploadedFile),
        waitForCompletion: false,
      });

      const uploadError = normalizeOperationError(operation?.error);
      const uploadStatus = operation?.done
        ? uploadError
          ? "failed"
          : "completed"
        : "pending";

      try {
        await upsertFileSearchStoreFn({
          fileSearchStoreName,
          lastUploadedFileName: uploadedFile.originalname,
          uploadOperationName: operation?.name || null,
          uploadStatus,
          uploadError,
          markUploadCompleted: uploadStatus === "completed",
        });
      } catch (historyError) {
        loggerInstance.warn("file_search.upload.history_upsert_failed", {
          requestId,
          fileSearchStoreName,
          error: historyError.message,
        });
      }

      loggerInstance.info("file_search.upload.operation_recorded", {
        requestId,
        fileSearchStoreName,
        operationName: operation?.name || null,
        status: uploadStatus,
      });

      loggerInstance.info("file_search.upload.accepted", {
        requestId,
        fileSearchStoreName,
        fileName: uploadedFile.originalname,
        processingStarted: true,
      });

      return res.status(202).json({
        uploaded: true,
        processingStarted: true,
        message: `File uploaded. Processing has started for ${uploadedFile.originalname}. You can start chatting now.`,
        fileName: uploadedFile.originalname,
        fileSearchStoreName,
        uploadOperation: {
          name: operation?.name || null,
          status: uploadStatus,
        },
      });
    } catch (error) {
      loggerInstance.error("file_search.upload.failed", {
        requestId,
        fileSearchStoreName: req.body?.fileSearchStoreName || null,
        fileName: uploadedFile?.originalname || null,
        error: error.message,
      });

      return sendError(
        res,
        502,
        "UPSTREAM_ERROR",
        error.message || "Failed to upload file to file search store.",
      );
    } finally {
      if (uploadedFile?.path) {
        loggerInstance.info("file_search.upload.temp_file_cleanup", {
          requestId,
          tempPath: uploadedFile.path,
        });
        fsPromises.rm(uploadedFile.path, { force: true }).catch(() => {});
      }
    }
  });

  app.post("/api/suggestions", async (req, res) => {
    const requestId = req.requestId || null;

    try {
      const fileSearchStoreName = String(req.body?.fileSearchStoreName || "").trim();
      const sourceLinks = parseLinks(req.body?.sourceLinks);

      loggerInstance.info("suggestions.request.start", {
        requestId,
        fileSearchStoreName: fileSearchStoreName || null,
        sourceLinkCount: sourceLinks.length,
      });

      const questions = await generateSuggestedQuestionsFn({
        fileSearchStoreName,
        sourceLinks,
      });

      if (fileSearchStoreName) {
        try {
          await upsertFileSearchStoreFn({
            fileSearchStoreName,
            queryIncrement: 0,
            suggestionIncrement: 1,
          });
        } catch (historyError) {
          loggerInstance.warn("suggestions.history_upsert_failed", {
            requestId,
            fileSearchStoreName,
            error: historyError.message,
          });
        }
      }

      loggerInstance.info("suggestions.request.success", {
        requestId,
        fileSearchStoreName: fileSearchStoreName || null,
        questionCount: questions.length,
      });

      return res.json({
        questions,
      });
    } catch (error) {
      loggerInstance.error("suggestions.request.failed", {
        requestId,
        error: error.message,
      });

      return res.status(500).json({
        error: error.message || "Failed to generate suggested questions.",
      });
    }
  });

  app.post("/api/chat", async (req, res) => {
    const requestId = req.requestId || null;

    try {
      const message = String(req.body?.message || "").trim();
      const sessionId = String(req.body?.sessionId || randomUUID());
      const fileSearchStoreName = String(req.body?.fileSearchStoreName || "").trim();

      const theoreticalData = parseOptionalData(req.body?.theoreticalData, "theoreticalData");
      const actualData = parseOptionalData(req.body?.actualData, "actualData");
      const sourceLinks = parseLinks(req.body?.sourceLinks);
      const hasComparisonPayload = theoreticalData != null && actualData != null;

      loggerInstance.info("chat.request.start", {
        requestId,
        sessionId,
        hasMessage: Boolean(message),
        messageLength: message.length,
        hasComparisonPayload,
        sourceLinkCount: sourceLinks.length,
        fileSearchStoreName: fileSearchStoreName || null,
      });

      if (!message && !hasComparisonPayload) {
        loggerInstance.warn("chat.request.validation_failed", {
          requestId,
          sessionId,
          reason: "Missing message and missing comparison payload.",
        });

        return res.status(400).json({
          error: "Send a message or provide both theoreticalData and actualData.",
        });
      }

      let reply;
      let mode;
      let comparison = null;

      if (hasComparisonPayload) {
        const report = buildDeterministicReportFn({
          message,
          theoreticalData,
          actualData,
          sourceLinks,
        });

        loggerInstance.info("chat.request.deterministic_report_created", {
          requestId,
          sessionId,
          metricCount: report.rows.length,
        });

        reply = report.report;
        mode = "deterministic-comparison";
        comparison = {
          rows: report.rows,
          summary: report.summary,
        };
      } else {
        loggerInstance.info("chat.request.llm_generation_start", {
          requestId,
          sessionId,
          fileSearchEnabled: Boolean(fileSearchStoreName),
        });

        const generated = await generateAnswerWithFileSearchFn({
          prompt: message,
          fileSearchStoreName,
          sourceLinks,
        });

        reply = appendSourcesSection(generated.text, sourceLinks);
        mode = "llm-factual-mode";

        loggerInstance.info("chat.request.llm_generation_success", {
          requestId,
          sessionId,
          replyLength: reply.length,
        });
      }

      const persistence = await saveChatExchangeFn({
        sessionId,
        userMessage: message || "[comparison request]",
        assistantMessage: reply,
        sourceLinks,
        fileSearchStoreName,
      });

      if (fileSearchStoreName) {
        try {
          await upsertFileSearchStoreFn({
            fileSearchStoreName,
            queryIncrement: 1,
          });
        } catch (historyError) {
          loggerInstance.warn("chat.request.history_upsert_failed", {
            requestId,
            sessionId,
            fileSearchStoreName,
            error: historyError.message,
          });
        }
      }

      if (persistence.saved) {
        loggerInstance.info("chat.request.persistence_saved", {
          requestId,
          sessionId,
        });
      } else {
        loggerInstance.warn("chat.request.persistence_failed", {
          requestId,
          sessionId,
          reason: persistence.reason || "unknown",
        });
      }

      loggerInstance.info("chat.request.success", {
        requestId,
        sessionId,
        mode,
        sourceLinkCount: sourceLinks.length,
      });

      return res.json({
        sessionId,
        mode,
        reply,
        comparison,
        sourceLinks,
        persistence,
      });
    } catch (error) {
      loggerInstance.error("chat.request.failed", {
        requestId,
        error: error.message,
      });

      return res.status(400).json({
        error: error.message || "Failed to process chat request.",
      });
    }
  });

  app.use("/api", (req, res) => {
    return sendError(
      res,
      404,
      "NOT_FOUND",
      `Route not found: ${req.method} ${req.originalUrl}`,
    );
  });

  const clientDist = path.join(__dirname, "client", "dist");
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));

    app.use((req, res, next) => {
      if (req.path.startsWith("/api")) {
        return next();
      }

      return res.sendFile(path.join(clientDist, "index.html"));
    });
  }

  app.use((error, req, res, _next) => {
    const requestId = req?.requestId || null;

    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      loggerInstance.warn("upload.middleware.limit_file_size", {
        requestId,
        error: error.message,
        uploadMaxMb: fileUploadMaxMb,
      });

      return sendError(
        res,
        413,
        "VALIDATION_ERROR",
        `File too large. Max supported size is ${fileUploadMaxMb}MB.`,
      );
    }

    if (error instanceof multer.MulterError) {
      loggerInstance.warn("upload.middleware.multer_error", {
        requestId,
        error: error.message,
        code: error.code,
      });

      return sendError(res, 400, "VALIDATION_ERROR", `Upload failed: ${error.message}`);
    }

    if (error instanceof Error) {
      loggerInstance.error("server.unhandled_error", {
        requestId,
        error: error.message,
      });

      return sendError(res, 500, "INTERNAL_ERROR", error.message);
    }

    loggerInstance.error("server.unexpected_error_shape", {
      requestId,
    });

    return sendError(res, 500, "INTERNAL_ERROR", "Unexpected upload error.");
  });

  return app;
}

async function startServer({
  port = PORT,
  uploadDir = UPLOAD_DIR,
  appInstance,
  loggerInstance = logger,
} = {}) {
  await fsPromises.mkdir(uploadDir, { recursive: true });
  const app = appInstance || createApp({ uploadDir, logger: loggerInstance });

  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      loggerInstance.info("server.started", {
        port,
        url: `http://localhost:${port}`,
        uploadMaxMb: FILE_UPLOAD_MAX_MB,
      });
      resolve(server);
    });
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    logger.error("server.start_failed", {
      error: error.message,
    });
    process.exit(1);
  });
}

module.exports = {
  createApp,
  startServer,
};
