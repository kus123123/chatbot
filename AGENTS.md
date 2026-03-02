# AGENTS.md

## Project Overview
- Stack: Node.js (Express API) + React (Vite frontend) + Google Gemini File Search (`@google/genai`) + Firebase Firestore persistence.
- Purpose: Realtime monitoring chatbot that compares theoretical vs actual data and returns verifiable, non-fabricated reports.

## Architecture
- `server.js` exposes `/api/chat`, `/api/file-search/store`, `/api/file-search/upload`, and `/api/health`.
- `server.js` also exposes `/api/file-search/stores` (store history), `/api/file-search/status` (indexing status polling), and `/api/suggestions` (dataset-driven prompts).
- `monitoring-report.js` performs deterministic comparison math (theoretical vs actual) without LLM modification.
- `search.js` handles Gemini + optional File Search tool usage with strict factual system instructions.
- `db-firebase.js` writes session/message history to Firestore with write timeouts so API responses are not blocked by Firebase outages/misconfiguration.
- `client/` contains the React app and calls the Node API.
- `/api/chat` now returns structured deterministic comparison data (`comparison.rows` + `comparison.summary`) for frontend rendering.
- `/api/health` includes `uploadMaxMb` so the UI can show active upload limits.
- `/api/file-search/upload` now returns immediately with `202` and `processingStarted: true` so users can continue chatting while indexing completes.
- `logger.js` provides shared structured console logging for backend flow tracing.
- `store-history.js` persists file-search store metadata locally (`data/file-search-stores.json`) for dropdown selection and query continuity.

## Conventions
- Source links are optional for both deterministic comparison and normal chat requests.
- Deterministic report mode is used when both `theoreticalData` and `actualData` are provided.
- Backend validates payload shape and returns explicit actionable errors.
- Backend logs are structured and include per-request IDs for `/api/*` routes.

## Known Gotchas
- Express 5 route wildcard `"*"` can fail with `path-to-regexp` v8; use middleware fallback instead.
- Firestore API may be disabled on a Firebase project by default. In that case writes fail or retry; timeout wrappers prevent hanging requests.
- `.env` values may contain extra spaces, so env reads should always trim values.
- Multipart uploads can exceed nominal file size due request overhead; keep a margin above intended max file size.
- File-search indexing is asynchronous after upload; immediate queries may return insufficient data until indexing catches up.

## Performance Notes
- Firestore writes are bounded with a short timeout to keep chat latency stable even when DB writes are unavailable.

## Session Log
- 2026-03-02: Implemented full-stack React + Node chatbot with Gemini File Search integration, deterministic theoretical-vs-actual comparison reporting, mandatory source link validation, and Firestore chat persistence.
- 2026-03-02: Added safe persistence behavior (write timeouts) after observing Firestore API disabled retries causing long response delays.
- 2026-03-02: Updated request validation so deterministic comparison can run without source links, while normal LLM chat still requires at least one valid source URL.
- 2026-03-02: Added formatted comparison rendering in React (table + summary + source section) using structured payload from backend instead of only raw markdown text.
- 2026-03-02: Added upload limit visibility in UI from `/api/health`; oversized file uploads return JSON error with current max MB.
- 2026-03-02: Removed source-link gating in frontend/backend for normal chat; users can chat with file-search context without manually entering links.
- 2026-03-02: Added upload processing UX (loader + explicit status message) and switched upload API to async-start semantics (`202 Accepted`).
- 2026-03-03: Added structured backend logging with request lifecycle events, route-level flow logs, and centralized logger toggles (`BACKEND_LOGS`, `BACKEND_LOG_MAX_STRING`).
- 2026-03-03: Improved assistant message formatting by rendering markdown (lists/headings/tables) in the chat UI instead of plain raw text.
- 2026-03-03: Added data-driven suggested questions endpoint (`/api/suggestions`) and UI panel with refresh + click-to-fill prompts.
- 2026-03-03: Strengthened suggested-question parser to handle fenced JSON responses safely.
- 2026-03-03: Added one-click “Run” action for suggested questions (direct chat execution in LLM mode).
- 2026-03-03: Added persistent store history API + UI dropdown so users can select previously created stores and query them later.
- 2026-03-03: Added fallback filtering for suggestion generation when model returns insufficiency text instead of usable questions.
- 2026-03-03: Added upload operation tracking in store history and a new `/api/file-search/status` endpoint to report indexing state (`pending/running/completed/failed/unknown`).
- 2026-03-03: Standardized error envelopes for file-search routes (`error.code` + `error.message`) and updated frontend parsing accordingly.
- 2026-03-03: Added frontend indexing readiness UX (status badge, polling every 5s, warning banner) and gated suggested-question “Run” until indexing completes.
- 2026-03-03: Added backend integration tests (`supertest` + Node test runner) covering upload operation metadata, file-search status API behavior, and store-history backward compatibility.
- 2026-03-03: Changed `/api/file-search/status` behavior for stores missing in local history from `404` to `200` with `indexing.status = "unknown"` to prevent noisy frontend errors for manually entered store IDs.
- 2026-03-03: Improved suggested-question quality by strengthening prompt instructions and adding backend post-processing (normalization, deduplication, minimum quality filter, fallback merge).
- 2026-03-03: Switched `/api/file-search/stores` to Gemini database-backed listing (merged with local counters), added delete-store API with permission gating and history cleanup, and updated UI dropdown labels to `displayName (full store id)` plus one-click remove action.
- 2026-03-03: Added API fallback JSON 404 handler for unknown `/api/*` routes and frontend compatibility handling to avoid rendering raw HTML error pages in status/error UI.
- 2026-03-03: Updated desktop layout to fixed-height app shell with independent left-panel scrolling and a more compact chat panel to prevent full-page scrolling during normal use.
- 2026-03-03: Added GitHub Actions CI/CD workflow (`.github/workflows/ci-cd.yml`) with CI checks (install, server tests, frontend build) and SSH-based auto-deploy on `main` to `naruto@76.13.247.66` with `pm2 restart chatbot`, preserving runtime `data/file-search-stores.json` during pull.
