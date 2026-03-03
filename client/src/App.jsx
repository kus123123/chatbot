import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const apiBase = import.meta.env.VITE_API_BASE_URL || "";

function toSourceLinks(rawText) {
  return rawText
    .split(/\r?\n|,/g)
    .map((value) => value.trim())
    .filter(Boolean);
}

function getErrorMessage(payload) {
  if (!payload) {
    return "Request failed.";
  }

  if (typeof payload.error === "string" && /<html|<!doctype/i.test(payload.error)) {
    return "Server returned an unexpected HTML error response.";
  }

  if (typeof payload.error === "string" && payload.error.trim()) {
    return payload.error.trim();
  }

  if (typeof payload.error?.message === "string" && payload.error.message.trim()) {
    return payload.error.message.trim();
  }

  return "Request failed.";
}

async function parseResponse(response) {
  const text = await response.text();
  let payload;

  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { error: text || "Unknown error" };
  }

  if (!response.ok) {
    const message = getErrorMessage(payload);
    const error = new Error(message);
    error.statusCode = response.status;
    throw error;
  }

  return payload;
}

function formatNumber(value, fractionDigits = 4) {
  if (value == null) {
    return "N/A";
  }

  if (typeof value !== "number") {
    return String(value);
  }

  if (Number.isInteger(value)) {
    return String(value);
  }

  return value.toFixed(fractionDigits).replace(/\.?0+$/, "");
}

function getStatusLabel(status) {
  switch (status) {
    case "matched":
      return "Matched";
    case "actual-above-theoretical":
      return "Above theoretical";
    case "actual-below-theoretical":
      return "Below theoretical";
    default:
      return "Insufficient data";
  }
}

function getIndexingLabel(status) {
  switch (status) {
    case "pending":
      return "Pending";
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    default:
      return "Unknown";
  }
}

export default function App() {
  const [sessionId, setSessionId] = useState("");
  const [fileSearchStoreName, setFileSearchStoreName] = useState("");
  const [storeHistory, setStoreHistory] = useState([]);
  const [storeDisplayName, setStoreDisplayName] = useState("realtime-monitoring-store");
  const [sourceLinksText, setSourceLinksText] = useState("");
  const [theoreticalJson, setTheoreticalJson] = useState("");
  const [actualJson, setActualJson] = useState("");
  const [message, setMessage] = useState("");
  const [selectedFile, setSelectedFile] = useState(null);
  const [messages, setMessages] = useState([]);
  const [statusText, setStatusText] = useState("Ready");
  const [uploadMaxMb, setUploadMaxMb] = useState(null);
  const [suggestedQuestions, setSuggestedQuestions] = useState([]);
  const [isSending, setIsSending] = useState(false);
  const [isCreatingStore, setIsCreatingStore] = useState(false);
  const [isUploadingFile, setIsUploadingFile] = useState(false);
  const [isLoadingSuggestions, setIsLoadingSuggestions] = useState(false);
  const [isLoadingStoreHistory, setIsLoadingStoreHistory] = useState(false);
  const [isDeletingStore, setIsDeletingStore] = useState(false);
  const [canDeleteStore, setCanDeleteStore] = useState(false);
  const [indexingStatus, setIndexingStatus] = useState("unknown");
  const [indexingError, setIndexingError] = useState(null);
  const [operationName, setOperationName] = useState("");
  const [isPollingIndexStatus, setIsPollingIndexStatus] = useState(false);

  const sourceLinks = useMemo(() => toSourceLinks(sourceLinksText), [sourceLinksText]);
  const selectedStore = useMemo(
    () =>
      storeHistory.find(
        (store) => store.fileSearchStoreName === fileSearchStoreName,
      ) || null,
    [storeHistory, fileSearchStoreName],
  );

  const hasStoreSelection = fileSearchStoreName.trim().length > 0;
  const isIndexingInProgress = indexingStatus === "pending" || indexingStatus === "running";
  const shouldShowIndexingWarning =
    hasStoreSelection &&
    (indexingStatus === "pending" ||
      indexingStatus === "running" ||
      indexingStatus === "failed");

  async function loadStoreHistory(preferredStoreName = null) {
    setIsLoadingStoreHistory(true);

    try {
      const response = await fetch(`${apiBase}/api/file-search/stores?limit=100`);
      const payload = await parseResponse(response);
      const stores = payload.stores || [];
      setStoreHistory(stores);
      setCanDeleteStore(Boolean(payload?.permissions?.canDelete));

      const preferred = String(preferredStoreName || "").trim();
      if (preferred) {
        setFileSearchStoreName(preferred);
      } else if (
        fileSearchStoreName &&
        stores.some((store) => store.fileSearchStoreName === fileSearchStoreName)
      ) {
        setFileSearchStoreName(fileSearchStoreName);
      } else if (stores.length > 0) {
        setFileSearchStoreName(stores[0].fileSearchStoreName);
      } else {
        setFileSearchStoreName("");
      }
    } catch (error) {
      setStatusText(error.message);
    } finally {
      setIsLoadingStoreHistory(false);
    }
  }

  async function loadSuggestedQuestions(storeNameInput, { silent = false } = {}) {
    const resolvedStoreName = String(storeNameInput || fileSearchStoreName || "").trim();
    if (!resolvedStoreName) {
      if (!silent) {
        setStatusText("Provide store name before generating data-based suggestions.");
      }
      return;
    }

    if (isIndexingInProgress) {
      if (!silent) {
        setStatusText("Indexing in progress. Suggestions will be available after indexing completes.");
      }
      return;
    }

    setIsLoadingSuggestions(true);
    if (!silent) {
      setStatusText("Generating suggested questions from your uploaded data...");
    }

    try {
      const response = await fetch(`${apiBase}/api/suggestions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileSearchStoreName: resolvedStoreName,
          sourceLinks,
        }),
      });

      const payload = await parseResponse(response);
      setSuggestedQuestions(payload.questions || []);
      if (!silent) {
        setStatusText("Suggested questions are ready.");
      }
    } catch (error) {
      if (!silent) {
        setStatusText(error.message);
      }
    } finally {
      setIsLoadingSuggestions(false);
    }
  }

  async function loadIndexStatus(storeNameInput) {
    const resolvedStoreName = String(storeNameInput || fileSearchStoreName || "").trim();
    if (!resolvedStoreName) {
      setIndexingStatus("unknown");
      setIndexingError(null);
      setOperationName("");
      setIsPollingIndexStatus(false);
      return;
    }

    try {
      const response = await fetch(
        `${apiBase}/api/file-search/status?fileSearchStoreName=${encodeURIComponent(
          resolvedStoreName,
        )}`,
      );
      const payload = await parseResponse(response);
      const indexing = payload.indexing || {};
      const nextStatus = String(indexing.status || "unknown");
      const shouldAutoRefresh = nextStatus === "completed" && indexingStatus !== "completed";

      setIndexingStatus(nextStatus);
      setIndexingError(indexing.error || null);
      setOperationName(indexing.operationName || "");

      if (nextStatus === "failed") {
        setStatusText(indexing.error || "Indexing failed. Re-upload the file to retry.");
      } else if (nextStatus === "completed") {
        setStatusText("Indexing completed. Dataset-backed suggestions are ready.");
      } else if (nextStatus === "pending" || nextStatus === "running") {
        setStatusText(`Indexing ${nextStatus}. Waiting for completion...`);
      }

      if (shouldAutoRefresh) {
        loadSuggestedQuestions(resolvedStoreName, { silent: true });
      }
    } catch (error) {
      const errorMessage = String(error?.message || "Failed to check indexing status.");
      const missingStatusRoute =
        Number(error?.statusCode) === 404 &&
        /file-search\/status|route not found/i.test(errorMessage);

      if (missingStatusRoute) {
        setIndexingStatus("unknown");
        setIndexingError(
          "Backend does not expose /api/file-search/status. Restart the updated server to enable indexing tracking.",
        );
        setStatusText(
          "Indexing status endpoint unavailable on current backend. Start/restart the latest server build.",
        );
        return;
      }

      setIndexingStatus("failed");
      setIndexingError(errorMessage);
      setStatusText(errorMessage);
    }
  }

  useEffect(() => {
    let mounted = true;

    async function loadHealth() {
      try {
        const response = await fetch(`${apiBase}/api/health`);
        if (!response.ok) {
          return;
        }

        const payload = await response.json();
        if (mounted) {
          setUploadMaxMb(payload.uploadMaxMb ?? null);
        }
      } catch {
        // Leave upload limit unknown if health check fails.
      }
    }

    loadHealth();
    loadStoreHistory();

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const resolvedStoreName = fileSearchStoreName.trim();
    if (!resolvedStoreName) {
      setIndexingStatus("unknown");
      setIndexingError(null);
      setOperationName("");
      setIsPollingIndexStatus(false);
      return;
    }

    loadIndexStatus(resolvedStoreName);
  }, [fileSearchStoreName]);

  useEffect(() => {
    const resolvedStoreName = fileSearchStoreName.trim();
    if (!resolvedStoreName || !isIndexingInProgress) {
      setIsPollingIndexStatus(false);
      return;
    }

    setIsPollingIndexStatus(true);
    const timer = setTimeout(() => {
      loadIndexStatus(resolvedStoreName);
    }, 5000);

    return () => {
      clearTimeout(timer);
    };
  }, [fileSearchStoreName, indexingStatus]);

  async function createStore() {
    setIsCreatingStore(true);
    setStatusText("Creating file search store...");

    try {
      const response = await fetch(`${apiBase}/api/file-search/store`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: storeDisplayName }),
      });

      const payload = await parseResponse(response);
      const storeName = payload.fileSearchStoreName || "";
      setFileSearchStoreName(storeName);
      setIndexingStatus("unknown");
      setIndexingError(null);
      setOperationName("");
      setStatusText(`Store ready: ${storeName}`);
      loadStoreHistory(storeName || null);
    } catch (error) {
      setStatusText(error.message);
    } finally {
      setIsCreatingStore(false);
    }
  }

  async function uploadFile() {
    if (!selectedFile) {
      setStatusText("Select a file first.");
      return;
    }

    if (!fileSearchStoreName.trim()) {
      setStatusText("Create or provide a file search store name first.");
      return;
    }

    setIsUploadingFile(true);
    setStatusText(`Uploading ${selectedFile.name}...`);

    try {
      const formData = new FormData();
      formData.append("file", selectedFile);
      formData.append("fileSearchStoreName", fileSearchStoreName.trim());
      formData.append("displayName", selectedFile.name);

      const response = await fetch(`${apiBase}/api/file-search/upload`, {
        method: "POST",
        body: formData,
      });

      const payload = await parseResponse(response);
      const resolvedStoreName = payload.fileSearchStoreName || fileSearchStoreName.trim();
      const uploadOperation = payload.uploadOperation || {};

      setStatusText(
        payload.message ||
          `File uploaded. Processing has started for ${selectedFile.name}. You can start chatting now.`,
      );
      setIndexingStatus(uploadOperation.status || "pending");
      setIndexingError(null);
      setOperationName(uploadOperation.name || "");

      if (resolvedStoreName) {
        setFileSearchStoreName(resolvedStoreName);
        loadStoreHistory(resolvedStoreName);
        loadIndexStatus(resolvedStoreName);
      }
      setSelectedFile(null);
    } catch (error) {
      setStatusText(error.message);
      setIndexingStatus("failed");
      setIndexingError(error.message);
    } finally {
      setIsUploadingFile(false);
    }
  }

  async function deleteStore() {
    const targetStoreName = fileSearchStoreName.trim();
    if (!targetStoreName) {
      setStatusText("Select a store to remove.");
      return;
    }

    if (!canDeleteStore) {
      setStatusText("You do not have permission to remove stores.");
      return;
    }

    const shouldDelete = window.confirm(
      `Remove store ${targetStoreName}? This deletes the store and its indexed documents.`,
    );
    if (!shouldDelete) {
      return;
    }

    setIsDeletingStore(true);
    setStatusText(`Removing store ${targetStoreName}...`);

    try {
      const response = await fetch(
        `${apiBase}/api/file-search/store?fileSearchStoreName=${encodeURIComponent(targetStoreName)}`,
        {
          method: "DELETE",
        },
      );
      await parseResponse(response);

      setFileSearchStoreName("");
      setIndexingStatus("unknown");
      setIndexingError(null);
      setOperationName("");
      setSuggestedQuestions([]);
      setStatusText(`Removed store: ${targetStoreName}`);
      loadStoreHistory();
    } catch (error) {
      setStatusText(error.message);
    } finally {
      setIsDeletingStore(false);
    }
  }

  async function sendChatRequest({
    messageOverride = null,
    llmOnly = false,
  } = {}) {
    const trimmedMessage =
      typeof messageOverride === "string" ? messageOverride.trim() : message.trim();
    const hasComparisonPayload =
      !llmOnly && theoreticalJson.trim().length > 0 && actualJson.trim().length > 0;

    if (!trimmedMessage && !hasComparisonPayload) {
      setStatusText("Enter a message or provide both theoretical and actual JSON data.");
      return;
    }

    setIsSending(true);
    setStatusText("Processing...");

    const outgoingLabel = trimmedMessage || "Comparison request";
    setMessages((prev) => [
      ...prev,
      {
        role: "user",
        content: outgoingLabel,
      },
    ]);

    try {
      const payload = {
        message: trimmedMessage,
        sessionId,
        fileSearchStoreName: fileSearchStoreName.trim(),
        sourceLinks,
      };

      if (theoreticalJson.trim()) {
        payload.theoreticalData = theoreticalJson;
      }

      if (actualJson.trim()) {
        payload.actualData = actualJson;
      }

      const response = await fetch(`${apiBase}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const result = await parseResponse(response);

      setSessionId(result.sessionId || sessionId);
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          mode: result.mode,
          content: result.reply,
          comparison: result.comparison || null,
          sourceLinks: result.sourceLinks || [],
        },
      ]);
      setStatusText(`Done (${result.mode})`);
      setMessage("");
      if (fileSearchStoreName.trim()) {
        loadStoreHistory(fileSearchStoreName.trim());
      }
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `Error: ${error.message}`,
        },
      ]);
      setStatusText(error.message);
    } finally {
      setIsSending(false);
    }
  }

  async function sendMessage(event) {
    event.preventDefault();
    await sendChatRequest();
  }

  async function runSuggestedQuestion(question) {
    if (isSending || indexingStatus !== "completed") {
      return;
    }

    await sendChatRequest({
      messageOverride: question,
      llmOnly: true,
    });
  }

  return (
    <div className="page">
      <header className="hero">
        <h1>Realtime Monitoring Expert Chatbot</h1>
        <p>
          Compares theoretical vs actual data with deterministic calculations and uses
          verifiable sources only.
        </p>
      </header>

      <main className="layout">
        <section className="panel controls">
          <h2>Data and Sources</h2>

          <label htmlFor="source-links">
            Source links (optional, one per line)
          </label>
          <textarea
            id="source-links"
            value={sourceLinksText}
            onChange={(event) => setSourceLinksText(event.target.value)}
            placeholder="https://example.com/realtime-dashboard\nhttps://example.com/theoretical-model"
          />

          <label htmlFor="theoretical-json">Theoretical data (JSON)</label>
          <textarea
            id="theoretical-json"
            value={theoreticalJson}
            onChange={(event) => setTheoreticalJson(event.target.value)}
            placeholder='{"temperature": 65, "pressure": 120}'
          />

          <label htmlFor="actual-json">Actual data (JSON)</label>
          <textarea
            id="actual-json"
            value={actualJson}
            onChange={(event) => setActualJson(event.target.value)}
            placeholder='{"temperature": 63.5, "pressure": 128}'
          />

          <h3>Google File Search</h3>

          <label htmlFor="store-display-name">Store display name</label>
          <input
            id="store-display-name"
            value={storeDisplayName}
            onChange={(event) => setStoreDisplayName(event.target.value)}
          />

          <div className="inline-actions">
            <button type="button" onClick={createStore} disabled={isCreatingStore}>
              {isCreatingStore ? "Creating..." : "Create Store"}
            </button>
            <button
              type="button"
              className="secondary-btn"
              onClick={() => loadStoreHistory()}
              disabled={isLoadingStoreHistory}
            >
              {isLoadingStoreHistory ? "Loading stores..." : "Refresh stores"}
            </button>
            <button
              type="button"
              className="danger-btn"
              onClick={deleteStore}
              disabled={isDeletingStore || !fileSearchStoreName.trim() || !canDeleteStore}
              title={canDeleteStore ? "Delete selected store" : "Store deletion disabled"}
            >
              {isDeletingStore ? "Removing..." : "Remove Store"}
            </button>
          </div>

          <label htmlFor="store-history">Store history</label>
          <select
            id="store-history"
            value={fileSearchStoreName}
            onChange={(event) => {
              const selectedName = event.target.value;
              setFileSearchStoreName(selectedName);
              if (selectedName) {
                setStatusText(`Selected store: ${selectedName}`);
              }
            }}
          >
            <option value="">Select a store from history</option>
            {storeHistory.map((store) => (
              <option key={store.fileSearchStoreName} value={store.fileSearchStoreName}>
                {`${store.displayName || store.fileSearchStoreName} (${store.fileSearchStoreName})`}
              </option>
            ))}
          </select>

          <label htmlFor="store-name">Store name</label>
          <input
            id="store-name"
            value={fileSearchStoreName}
            onChange={(event) => setFileSearchStoreName(event.target.value)}
            placeholder="filesearchstores/123456"
          />
          {selectedStore ? (
            <>
              <p className="store-meta">
                Uploads: {selectedStore.uploadCount || 0} | Queries: {selectedStore.queryCount || 0}
              </p>
              <div className={`indexing-badge indexing-${indexingStatus}`}>
                <span>Indexing: {getIndexingLabel(indexingStatus)}</span>
                {isPollingIndexStatus ? <span className="indexing-checking">Checking...</span> : null}
              </div>
              {operationName ? <p className="store-meta">Operation: {operationName}</p> : null}
              {indexingError ? <p className="indexing-error">{indexingError}</p> : null}
            </>
          ) : null}

          <input
            type="file"
            onChange={(event) => setSelectedFile(event.target.files?.[0] || null)}
          />

          <button type="button" onClick={uploadFile} disabled={isUploadingFile}>
            {isUploadingFile ? "Uploading..." : "Upload File"}
          </button>
          {isUploadingFile ? (
            <p className="upload-processing">
              <span className="spinner" /> File uploaded stream is in progress...
            </p>
          ) : null}
          <p className="upload-hint">
            Upload limit:{" "}
            {uploadMaxMb != null ? `${uploadMaxMb}MB` : "configured on server (default 15MB)"}.
          </p>

          <div className="suggestions-panel">
            <div className="suggestions-head">
              <h3>Suggested Questions</h3>
              <button
                type="button"
                className="secondary-btn"
                onClick={() => loadSuggestedQuestions(fileSearchStoreName)}
                disabled={isLoadingSuggestions}
              >
                {isLoadingSuggestions ? "Loading..." : "Refresh"}
              </button>
            </div>

            {isIndexingInProgress ? (
              <p className="suggestions-empty">
                Indexing in progress. Suggestions will be ready after indexing completes.
              </p>
            ) : suggestedQuestions.length === 0 ? (
              <p className="suggestions-empty">
                Upload data, then click Refresh to generate questions based on your file.
              </p>
            ) : (
              <div className="suggestion-list">
                {suggestedQuestions.map((question, index) => (
                  <div key={`${question}-${index}`} className="suggestion-item">
                    <p>{question}</p>
                    <div className="suggestion-actions">
                      <button
                        type="button"
                        className="secondary-btn"
                        onClick={() => setMessage(question)}
                        title="Fill the input"
                      >
                        Use
                      </button>
                      <button
                        type="button"
                        onClick={() => runSuggestedQuestion(question)}
                        disabled={isSending || indexingStatus !== "completed"}
                        title="Run this query now"
                      >
                        Run
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        <section className="panel chat">
          <h2>Chat</h2>
          <p className="status">Status: {statusText}</p>
          <p className="status">Session: {sessionId || "Not started"}</p>
          {shouldShowIndexingWarning ? (
            <p className="indexing-warning">
              Dataset indexing is {getIndexingLabel(indexingStatus).toLowerCase()}. Chat is available,
              but file-search answers may be incomplete until indexing completes.
            </p>
          ) : null}

          <div className="messages">
            {messages.length === 0 ? (
              <p className="placeholder">No messages yet.</p>
            ) : (
              messages.map((item, index) => (
                <article key={`${item.role}-${index}`} className={`message ${item.role}`}>
                  <h4>
                    {item.role === "user" ? "You" : "Assistant"}
                    {item.mode ? ` (${item.mode})` : ""}
                  </h4>

                  {item.comparison?.rows ? (
                    <div className="comparison-view">
                      <div className="comparison-table-wrap">
                        <table className="comparison-table">
                          <thead>
                            <tr>
                              <th>Metric</th>
                              <th>Theoretical</th>
                              <th>Actual</th>
                              <th>Delta</th>
                              <th>Delta %</th>
                              <th>Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {item.comparison.rows.map((row) => (
                              <tr key={`${row.metric}-${row.status}`}>
                                <td>{row.metric}</td>
                                <td>{row.theoreticalValue}</td>
                                <td>{row.actualValue}</td>
                                <td>{row.delta}</td>
                                <td>{row.deltaPercent}</td>
                                <td>
                                  <span className={`status-pill ${row.status}`}>
                                    {getStatusLabel(row.status)}
                                  </span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      <div className="comparison-summary">
                        <strong>Summary</strong>
                        <p>Total metrics: {formatNumber(item.comparison.summary?.totalMetrics)}</p>
                        <p>Matched: {formatNumber(item.comparison.summary?.matched)}</p>
                        <p>Above theoretical: {formatNumber(item.comparison.summary?.above)}</p>
                        <p>Below theoretical: {formatNumber(item.comparison.summary?.below)}</p>
                        <p>
                          Insufficient data:{" "}
                          {formatNumber(item.comparison.summary?.insufficient)}
                        </p>
                        <p>
                          MAPE:{" "}
                          {item.comparison.summary?.meanAbsolutePercentError == null
                            ? "N/A"
                            : `${formatNumber(item.comparison.summary.meanAbsolutePercentError)}%`}
                        </p>
                      </div>

                      {item.sourceLinks?.length > 0 ? (
                        <div className="comparison-summary">
                          <strong>Sources</strong>
                          {item.sourceLinks.map((link) => (
                            <p key={link}>{link}</p>
                          ))}
                        </div>
                      ) : null}

                      <details className="raw-report">
                        <summary>Raw report text</summary>
                        <pre>{item.content}</pre>
                      </details>
                    </div>
                  ) : item.role === "assistant" ? (
                    <div className="markdown-content">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {item.content}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <pre>{item.content}</pre>
                  )}
                </article>
              ))
            )}
          </div>

          <form className="composer" onSubmit={sendMessage}>
            <label htmlFor="message-input">Prompt (optional when sending comparison JSON)</label>
            <textarea
              id="message-input"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Analyze the variance and summarize operational risk."
            />
            <button type="submit" disabled={isSending}>
              {isSending ? "Sending..." : "Send"}
            </button>
          </form>
        </section>
      </main>
    </div>
  );
}
