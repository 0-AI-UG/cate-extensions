# cate.sourcebot — implementation status

A Cate extension that wraps **Sourcebot** (https://github.com/sourcebot-dev/sourcebot),
a self-hosted, Zoekt-based code-search / code-understanding tool.

## 1. License finding (the gate)

**Verdict: do NOT bundle Sourcebot's code. Connect to a user-run instance instead.**

- Sourcebot relicensed (v4.5.3) from MIT to the **Functional Source License,
  Version 1.1, ALv2 Future License** (`LICENSE.md` in their repo; announced at
  https://www.sourcebot.dev/blog/fair-source).
- FSL is a *fair-source* (not open-source, not permissive) license. It grants
  use/modify/redistribute for any **Permitted Purpose**, but forbids a
  **Competing Use** — defined as "making the Software available to others in a
  commercial product or service" that substitutes for or offers substantially
  the same functionality as Sourcebot. The license converts to **Apache-2.0**
  two years after each release (the "Future License" / change date).
- Cate's extension catalog ships under permissive terms. Bundling Sourcebot's
  server/UI into that catalog and redistributing it would risk the Competing-Use
  clause (we'd be making Sourcebot "available to others" as part of a product).

**Consequence for this extension:** it contains **none of Sourcebot's code**. The
extension is its own small MIT-style Node server that acts as a thin reverse
proxy + native-search backend in front of a Sourcebot instance the **user runs
and configures** (base URL + optional API key). This sidesteps the license
entirely — we ship glue, not Sourcebot.

(The separate `@sourcebot/mcp` npm package and the built-in `/api/mcp` endpoint
are likewise the user's deployment, not bundled here.)

## 2. Architecture

Server-backed extension (`manifest.json` has a `server` block). Cate spawns
`node dist/server.js` per workspace, injects `PORT` / `CATE_TOKEN` /
`WORKSPACE_ROOT` / `CATE_API`, probes `/health`, and reverse-proxies the panel
webview to it (sandboxed, tight CSP, per-extension partition).

```
Cate webview ──(Cate proxy + tunnel, injects CATE_TOKEN)──► our Node server ──(plain http/https, injects Sourcebot API key)──► user's Sourcebot
```

Files:
- `src/server.ts` — the extension server. Serves the panel; exposes
  `/api/config`, `/sbapi/search` (native search → normalized hits), and `/sb/*`
  (raw reverse-proxy of Sourcebot's web UI for the embedded iframe).
- `src/sourcebot.ts` — **pure** helpers: `normalizeSearchResponse` (flattens
  Sourcebot's Zoekt-shaped `/api/search` JSON into `{repository, path, line,
  snippet}` hits, defensively across version drift), `normalizeBaseUrl`,
  `joinUrl`, `clampMatches`.
- `src/sourcebotClient.ts` — dependency-free http/https client to the user's
  Sourcebot; `authHeaders`, `requestUpstream`, `probe`, `rewriteLocation`.
- `src/public/{index.html,style.css,app.ts}` — the panel: native search UI,
  connection settings, browse-iframe toggle, theming.
- `src/sourcebot.test.ts` — Vitest unit tests (15, all passing).

### Cate-native glue (the point of the integration)

1. **Search hit → `cate.editor.openFile`.** The panel runs its **own** search UI
   (it does not try to rewrite Sourcebot's HTML). It POSTs to `/sbapi/search`,
   the server calls Sourcebot's `POST /api/search`, and `normalizeSearchResponse`
   flattens the result to `{repository, path, line, snippet}`. Each rendered hit
   is a button whose click calls
   `cate.editor.openFile(hit.path, { line: hit.line })` — clicking a search
   result opens that file at that line in a Cate editor panel. (Verified
   end-to-end against a fake Sourcebot upstream.)
2. **Theming.** On load the panel calls `cate.theme.get()` and maps Cate's app
   palette (`editor-bg`, `accent`, `border`, …) onto its CSS variables, so the
   panel matches the active Cate theme (dark/light).
3. **Connection config.** Base URL + optional API key are stored via
   `cate.storage` (declared `storage` scope). The server reads them back over
   `CATE_API`, so the API key is injected **server-side** and never rides in a
   URL the sandboxed webview can read.
4. **Browse mode.** A "Browse" toggle loads Sourcebot's full web UI in a
   same-origin iframe via the `/sb/*` reverse-proxy (framing guards stripped,
   redirects rewritten under `/sb/`). This is best-effort convenience, not the
   primary surface (see Limitations).

### MCP integration (documented, not built — by design)

Sourcebot ships an MCP server so AI agents can search/read code. Two forms exist:
- **Built-in**: current Sourcebot exposes Streamable-HTTP MCP at
  `<baseUrl>/api/mcp` (paid plan for OAuth; API-key auth works on any plan;
  anonymous if the instance allows it).
- **Standalone**: the historical `@sourcebot/mcp` npm package, configured with
  `SOURCEBOT_HOST` (+ API key).

To expose this to **Cate's own agent** (a separate integration, not part of this
extension): register the Sourcebot MCP endpoint in Cate's agent/pi MCP-server
config so the agent gains Sourcebot's tools (`grep`, `read_file`,
`find_symbol_definitions`, `find_symbol_references`, `ask_codebase`, …). That is
agent-side configuration, orthogonal to this panel; this extension deliberately
does not register MCP servers on the user's behalf. The same stored base
URL/API key here could seed that config.

## 3. Implemented & verified vs. stubbed

**Verified (built + run locally):**
- Build: `npm run build` clean; `npm run typecheck` clean.
- Tests: `npm test` → 15/15 passing (`src/sourcebot.test.ts`).
- Catalog packaging: the repo-level `./build.sh` tars
  `cate.sourcebot-0.1.0.tgz` with `manifest.json` + `dist/` at the tar root and
  emits a valid catalog entry (sha256 + description).
- Server smoke test: `/health` auth-exempt 200; `/` 401 without token / 200 with
  token; `/api/config` and `/sbapi/search` degrade cleanly when unconfigured.
- **End-to-end search**: against a fake Sourcebot + fake CATE_API, the server
  read stored config, probed the upstream (`reachable:true`), forwarded the
  search with the injected API key, and returned a normalized hit
  (`{path:"src/a.ts", line:12, snippet:"hello world"}`) — the exact payload the
  panel feeds to `cate.editor.openFile`.

**Not verified (requires a live Sourcebot + a running Cate):**
- The `/sb/*` reverse-proxy of Sourcebot's full Next.js UI inside the iframe.
  Subpath-proxying a Next.js app is best-effort: deep links / client-side
  routing / absolute asset URLs may not all survive. The **native search path is
  the primary, fully-supported surface**; browse mode is a convenience.
- Real `cate.editor.openFile` behavior in-app (tested against the documented
  contract and a stubbed reply, not a live Cate window).

**Not built (documented above):** the MCP→Cate-agent wiring.

## 4. Run model / infra requirements

Sourcebot is heavy infra and is **the user's responsibility**, not shipped here:
- Sourcebot runs as a **single Docker container** (it embeds Zoekt for indexing
  + a Next.js web app). Typical run, per their docs:
  ```
  docker run -d --name sourcebot -p 3000:3000 \
    -v $(pwd)/.sourcebot:/data \
    ghcr.io/sourcebot-dev/sourcebot:latest
  ```
  plus a `config.json` declaring the repos/orgs to index. It needs disk for the
  Zoekt index and (for private repos) host tokens.
- Once it's up at e.g. `http://localhost:3000`, open this extension's panel,
  click ⚙, enter that URL (and an API key from Sourcebot Settings if the
  instance requires auth), and Save & test.

## 5. How to build / run

```bash
cd extensions/cate.sourcebot
npm install
npm run build       # tsc server + browser, copy static assets -> dist/
npm test            # vitest, 15 tests
npm run typecheck   # optional
```

Sideload in Cate: Settings → Extensions → add this folder as a local extension,
enable it, open the **Sourcebot** panel, configure your instance URL via ⚙.

Or via catalog: from the repo root run `./build.sh`, then point a Cate catalog
source at `dist/catalog/index.json`.

## 6. Shared-file registration a human must apply

**None inside Cate's `src/`.** This extension is self-contained under
`extensions/cate.sourcebot/`. Discovery is automatic:
- The repo-level `./build.sh` + `scripts/gen-catalog.mjs` already pick up any
  folder under `extensions/` with a `manifest.json`, so `cate.sourcebot`
  appears in the generated catalog with no edits (verified — it is in
  `dist/catalog/index.json`).
- On merge to `main`, the existing CI publishes it like the other extensions.

No edits were made to Cate's `src/`, to other extensions, or to the repo's
`build.sh` / catalog scripts.

## 7. Permissions (manifest `cateApi` scopes)

- `storage` — persist the Sourcebot base URL + API key (read back server-side).
- `editor.write` — open a search hit in a Cate editor (`editor.openFile`).
- `theme` — match the active Cate theme.
- `ui` — surface notifications.
- `workspace.read` — workspace context (reserved; openFile is workspace-confined
  by the host).
