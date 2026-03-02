const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

const request = require("supertest");

const { createApp } = require("../../server");
const {
  listFileSearchStores,
  getFileSearchStoreByName,
  upsertFileSearchStore,
} = require("../../store-history");

const noopLogger = {
  info() {},
  warn() {},
  error() {},
};

function createTestApp(overrides = {}) {
  return createApp({
    logger: noopLogger,
    uploadDir: path.join(process.cwd(), "tmp-uploads-test"),
    fileUploadMaxMb: 2,
    createFileSearchStore: async () => ({
      name: "fileSearchStores/default",
      displayName: "default",
    }),
    uploadFileToStore: async () => ({
      name: "operations/default",
      done: false,
      error: null,
    }),
    getUploadOperationStatus: async () => ({
      status: "running",
      done: false,
      error: null,
      operationName: "operations/default",
    }),
    generateAnswerWithFileSearch: async () => ({
      text: "ok",
    }),
    generateSuggestedQuestions: async () => ["Q1"],
    saveChatExchange: async () => ({ saved: false, reason: "disabled in tests" }),
    getFirestoreStatus: () => ({ ready: false, error: null }),
    buildDeterministicReport: () => ({
      report: "report",
      rows: [],
      summary: {
        totalMetrics: 0,
        matched: 0,
        above: 0,
        below: 0,
        insufficient: 0,
        meanAbsolutePercentError: null,
      },
    }),
    normalizeSourceLinks: (value) => {
      if (Array.isArray(value)) {
        return value.filter(Boolean);
      }

      if (typeof value === "string") {
        return value
          .split(/\r?\n|,/g)
          .map((item) => item.trim())
          .filter(Boolean);
      }

      return [];
    },
    listFileSearchStores: async () => [],
    getFileSearchStoreByName: async () => null,
    upsertFileSearchStore: async () => {},
    ...overrides,
  });
}

test("POST /api/file-search/upload returns operation metadata", async () => {
  const upserts = [];
  const app = createTestApp({
    uploadFileToStore: async () => ({
      name: "operations/abc",
      done: false,
      error: null,
    }),
    upsertFileSearchStore: async (payload) => {
      upserts.push(payload);
    },
  });

  const response = await request(app)
    .post("/api/file-search/upload")
    .field("fileSearchStoreName", "fileSearchStores/123")
    .attach("file", Buffer.from("colA,colB\n1,2"), "sample.csv");

  assert.equal(response.status, 202);
  assert.equal(response.body.fileSearchStoreName, "fileSearchStores/123");
  assert.equal(response.body.uploadOperation.name, "operations/abc");
  assert.equal(response.body.uploadOperation.status, "pending");

  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].uploadOperationName, "operations/abc");
  assert.equal(upserts[0].uploadStatus, "pending");
});

test("GET /api/file-search/status validates required query", async () => {
  const app = createTestApp();

  const response = await request(app).get("/api/file-search/status");

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, "VALIDATION_ERROR");
});

test("GET /api/file-search/status returns unknown when store is missing in local history", async () => {
  const app = createTestApp();

  const response = await request(app)
    .get("/api/file-search/status")
    .query({ fileSearchStoreName: "fileSearchStores/missing" });

  assert.equal(response.status, 200);
  assert.equal(response.body.indexing.status, "unknown");
  assert.match(response.body.indexing.message, /not present in local history/i);
});

test("GET /api/file-search/status returns running for in-progress operation", async () => {
  const store = {
    fileSearchStoreName: "fileSearchStores/live",
    lastUploadOperationName: "operations/live-op",
    lastUploadStatus: "pending",
    lastUploadError: null,
    lastUploadedFileName: "metrics.csv",
    lastUploadedAt: "2026-03-03T01:00:00.000Z",
    lastUploadCheckedAt: null,
    lastUploadCompletedAt: null,
  };

  const app = createTestApp({
    getFileSearchStoreByName: async () => store,
    getUploadOperationStatus: async () => ({
      status: "running",
      done: false,
      error: null,
      operationName: "operations/live-op",
    }),
    upsertFileSearchStore: async (payload) => {
      store.lastUploadStatus = payload.uploadStatus;
      store.lastUploadError = payload.uploadError;
      store.lastUploadOperationName = payload.uploadOperationName;
      store.lastUploadCheckedAt = "2026-03-03T01:00:20.000Z";
    },
  });

  const response = await request(app)
    .get("/api/file-search/status")
    .query({ fileSearchStoreName: store.fileSearchStoreName });

  assert.equal(response.status, 200);
  assert.equal(response.body.indexing.status, "running");
  assert.equal(response.body.indexing.operationName, "operations/live-op");
});

test("GET /api/file-search/status returns completed and marks completion", async () => {
  const store = {
    fileSearchStoreName: "fileSearchStores/completed",
    lastUploadOperationName: "operations/completed-op",
    lastUploadStatus: "running",
    lastUploadError: null,
    lastUploadCompletedAt: null,
  };

  const upsertCalls = [];
  const app = createTestApp({
    getFileSearchStoreByName: async () => store,
    getUploadOperationStatus: async () => ({
      status: "completed",
      done: true,
      error: null,
      operationName: "operations/completed-op",
    }),
    upsertFileSearchStore: async (payload) => {
      upsertCalls.push(payload);
      store.lastUploadStatus = payload.uploadStatus;
      store.lastUploadCompletedAt = "2026-03-03T01:01:00.000Z";
      store.lastUploadCheckedAt = "2026-03-03T01:01:00.000Z";
    },
  });

  const response = await request(app)
    .get("/api/file-search/status")
    .query({ fileSearchStoreName: store.fileSearchStoreName });

  assert.equal(response.status, 200);
  assert.equal(response.body.indexing.status, "completed");
  assert.equal(upsertCalls.length, 1);
  assert.equal(upsertCalls[0].markUploadCompleted, true);
});

test("GET /api/file-search/status returns failed and exposes error", async () => {
  const store = {
    fileSearchStoreName: "fileSearchStores/failed",
    lastUploadOperationName: "operations/failed-op",
    lastUploadStatus: "running",
    lastUploadError: null,
  };

  const app = createTestApp({
    getFileSearchStoreByName: async () => store,
    getUploadOperationStatus: async () => ({
      status: "failed",
      done: true,
      error: "Document parsing failed",
      operationName: "operations/failed-op",
    }),
    upsertFileSearchStore: async (payload) => {
      store.lastUploadStatus = payload.uploadStatus;
      store.lastUploadError = payload.uploadError;
      store.lastUploadCheckedAt = "2026-03-03T01:02:00.000Z";
    },
  });

  const response = await request(app)
    .get("/api/file-search/status")
    .query({ fileSearchStoreName: store.fileSearchStoreName });

  assert.equal(response.status, 200);
  assert.equal(response.body.indexing.status, "failed");
  assert.equal(response.body.indexing.error, "Document parsing failed");
});

test("store-history keeps backward compatibility with records missing upload status fields", async () => {
  const storesFile = path.join(process.cwd(), "data", "file-search-stores.json");
  let originalFile = null;

  try {
    originalFile = await fs.readFile(storesFile, "utf8");
  } catch {
    originalFile = null;
  }

  try {
    await fs.mkdir(path.dirname(storesFile), { recursive: true });
    await fs.writeFile(
      storesFile,
      JSON.stringify(
        [
          {
            fileSearchStoreName: "fileSearchStores/legacy",
            displayName: "Legacy Store",
            createdAt: "2026-03-03T01:00:00.000Z",
            updatedAt: "2026-03-03T01:00:00.000Z",
            uploadCount: 1,
            queryCount: 2,
            suggestionCount: 1,
          },
        ],
        null,
        2,
      ),
      "utf8",
    );

    const listed = await listFileSearchStores({ limit: 10 });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].lastUploadStatus, null);
    assert.equal(listed[0].lastUploadOperationName, null);

    await upsertFileSearchStore({
      fileSearchStoreName: "fileSearchStores/legacy",
      uploadOperationName: "operations/legacy-op",
      uploadStatus: "running",
      uploadError: null,
    });

    const updated = await getFileSearchStoreByName("fileSearchStores/legacy");
    assert.equal(updated.lastUploadOperationName, "operations/legacy-op");
    assert.equal(updated.lastUploadStatus, "running");
    assert.equal(updated.lastUploadError, null);
  } finally {
    if (originalFile == null) {
      await fs.rm(storesFile, { force: true });
    } else {
      await fs.writeFile(storesFile, originalFile, "utf8");
    }
  }
});
