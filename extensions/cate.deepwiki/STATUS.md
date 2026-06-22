# STATUS — cate.deepwiki

A **connect-only** Cate extension: a small, dependency-free Node server that
reverse-proxies the Cate panel to a **DeepWiki-Open instance you run yourself**,
and adds Cate-native glue (code-reference links → editor, theming, provider-key
reuse surfaced as a ready-to-paste `.env`). It does **not** bundle, fetch, or
start DeepWiki.

## 1. License (informational)

- **DeepWiki-Open** (`AsyncFuncAI/deepwiki-open`) is **MIT licensed**
  (`Copyright (c) 2024 Sheing Ng`,
  <https://github.com/AsyncFuncAI/deepwiki-open/blob/main/LICENSE>) — verified.
- We do not redistribute DeepWiki, so MIT only matters as confirmation there is
  no blocker to a future bundling option. This build connects to a user-run
  instance; nothing of DeepWiki ships in the artifact.

## 2. Why connect-only (not bundled)

DeepWiki-Open is a **Python/FastAPI backend + Next.js frontend** with heavy
native deps (embedding stores via `adalflow`/FAISS, etc.), default deployment is
**docker-compose** (frontend `:3000`, FastAPI `:8001`, embedding cache under
`~/.adalflow`), and it needs the user's own LLM + embeddings credentials. Cate's
catalog CI builds JS/TS extensions into a small `.tgz` (`manifest.json` +
`dist/`) and has no Python toolchain. So the user runs DeepWiki (one
`docker compose up`); this extension is a thin reverse-proxy + control panel.

## 3. What's implemented

- `manifest.json` — server-backed (`node dist/server.js`); scopes
  `storage, editor, theme, ui, workspace.read`.
- `src/server.ts` — dependency-free Node server (Node `http` only):
  - Binds `PORT` on `127.0.0.1` and answers `GET /health` immediately (Cate's
    readiness probe).
  - Resolves the upstream origin: stored value (`cate.storage`, key
    `deepwiki:upstream`, read server-side over `CATE_API`) → `DEEPWIKI_UPSTREAM`
    env → none.
  - With an upstream configured, reverse-proxies all non-control HTTP **and
    WebSocket** traffic to it, stripping `X-Frame-Options` + upstream CSP so it
    frames in the sandboxed webview.
  - With no upstream, serves the config page.
  - Control routes: `GET /api/status` (configured upstream, reachability,
    reusable Cate providers), `GET /api/env` (ready-to-paste DeepWiki `.env`),
    `POST /api/upstream` (set/clear the upstream via `cate.storage`).
- `src/config.ts` (pure, tested) — upstream URL normalization/resolution and the
  **code-reference parser** (`src/foo.ts#L42`, `path:line`, `?line=`,
  `cate-open:` scheme), with traversal/URL/anchor rejection.
- `src/auth.ts` (pure, tested) — maps Cate's `pi-agent/auth.json` +
  `models.json` to DeepWiki env (`OPENAI_API_KEY`, `GOOGLE_API_KEY`,
  `OPENROUTER_API_KEY`, `OPENAI_BASE_URL`).
- `src/public/` — control panel: theme via `cate.theme.get()`, connect/disconnect
  UI, `.env` copy, and the **iframe code-reference glue** that routes wiki source
  citations to `cate.editor.openFile(path, { line })` (plus a `postMessage`
  fallback).

## 4. Verified vs not

**Verified in this environment:**

- `npm run build`, `npm run typecheck`, and `npm test` are green (see §6 of the
  task report / `npm test` output: 19 passing across `auth` + `config`).
- DeepWiki-Open's MIT license.

**Not verified (no live DeepWiki / no LLM+embeddings keys available offline):**

- **End-to-end render.** The proxy + iframe glue are covered by unit tests and a
  clean build, not an actual DeepWiki page load.
- **Code-ref link markup.** DeepWiki's exact citation-link shapes weren't checked
  against a running instance; the parser accepts the common shapes defensively
  and may need a tweak once tested live. The `postMessage` channel is the
  fallback if same-origin iframe access is ever blocked.
- **Provider reuse is derivation + manual paste.** We don't spawn DeepWiki, so we
  can't set its env. We *surface* the matching `.env` (`/api/env` + panel
  "copy .env") for the user to paste into their DeepWiki. The derivation is
  implemented and tested; the cross-process handoff is manual by design.

## 5. DeepWiki requirements (set in DeepWiki's own `.env`)

- **At least one LLM key** — `OPENAI_API_KEY`, `GOOGLE_API_KEY`, or
  `OPENROUTER_API_KEY` (DeepWiki also supports Azure, AWS Bedrock, DashScope,
  Ollama).
- **Embeddings** — default `DEEPWIKI_EMBEDDER_TYPE=openai` (needs
  `OPENAI_API_KEY`); `google` / `ollama` are alternatives.
- **`OPENAI_BASE_URL`** — DeepWiki documents this as supporting OpenAI-compatible
  services and local proxies, which is how Cate's custom endpoint
  (`models.json.custom.baseUrl`) maps in.
- **Ports** — frontend `:3000`, FastAPI `:8001`; embedding cache `~/.adalflow`.

## 6. Catalog registration

**None required.** `cate-extensions/build.sh` discovers any folder under
`extensions/` with a `manifest.json` and regenerates `dist/catalog/index.json`
automatically. No edit to a shared registry, Cate's `src/`, or another extension
was made or is needed.

## 7. Build / run

```bash
cd cate-extensions/extensions/cate.deepwiki
npm install
npm run build      # src/ -> dist/
npm run typecheck  # clean
npm test           # 19 passing (auth + config helpers)
```

Then enable `cate.deepwiki` in Cate, open the panel, run your own DeepWiki
(`docker compose up` in a clone of deepwiki-open), and enter
`http://localhost:3000` in the panel (or preset it via `DEEPWIKI_UPSTREAM`).
