# Kitchen Sink — Cate Extension API Demo

A **server-backed** Cate extension that exercises the entire extension stack end
to end. Authored in **TypeScript** and compiled to `dist/` by `npm run build`;
dependency-free at runtime (Node `http` + raw WebSocket frames), so the shipped
`.tgz` carries only compiled JS — no `node_modules`.

## What it proves

| Layer | Where | How it's exercised |
| --- | --- | --- |
| **cateHost bridge** | `src/public/app.ts` | `cate.version`, `cate.workspace.get`, `cate.theme.get` (theme tokens applied to the panel's CSS vars), `cate.storage.get/set` (autosaved notes). |
| **Reverse API (page → Cate)** | `src/public/app.ts` | Buttons for `cate.editor.openFile('package.json')`, `cate.canvas.createPanel('extension', {extensionId, extensionPanelId})`, `cate.panel.setTitle`. |
| **HTTP tunnel** | `GET /api/info`, `POST /api/echo` | The page fetches its OWN server endpoints over relative URLs; requests tunnel page → proxy → daemon-hosted server. |
| **WebSocket tunnel** | `GET /ws` | The page opens a WS to its server and round-trips a message, proving WS upgrade tunneling. |
| **CATE_TOKEN injection** | `src/server.ts` | Every non-`/health` request REQUIRES `Authorization: Bearer ${CATE_TOKEN}` and 401s otherwise. The webview never holds the token; the proxy injects it. |
| **CATE_API reverse (server → Cate)** | `POST /api/cate-roundtrip` | The SERVER calls back into Cate via `process.env.CATE_API` (`cate.storage.set` then `cate.storage.get`) and returns the result. |
| **Readiness probe** | `GET /health` | Returns 200, auth-exempt — Cate's probe target. |

## How Cate runs it

Cate spawns `node dist/server.js` with `cwd` = the installed extension dir and
injects env:

- `PORT` — a free loopback port the server MUST bind on `127.0.0.1`.
- `CATE_TOKEN` — the bearer the proxy injects on every request to the server.
- `WORKSPACE_ROOT` — the workspace root on the runtime host.
- `CATE_API` — a loopback URL that tunnels back into Cate's reverse API.

The webview loads `http://127.0.0.1:<proxyPort>/ext/<routeToken>/?cateExt&cateWs&catePanel`;
all page requests/WS use **relative** URLs so they resolve under that route and
tunnel correctly.

## Build

```bash
npm install   # once, to fetch the TypeScript toolchain (dev-only)
npm run build # compiles src/ -> dist/ (server.js, public/app.js + static assets)
```

`npm run build` runs `tsc` against two configs, `tsconfig.server.json` (Node,
CommonJS) and `tsconfig.browser.json` (DOM, classic script), then copies the
static HTML/CSS into `dist/public/`. The repo's `build.sh` runs this
automatically and tars only `manifest.json` + `dist/`.

## Layout

```
cate.kitchensink/
  manifest.json          # server-backed manifest (command: node dist/server.js)
  package.json           # build scripts + TypeScript dev deps
  tsconfig*.json         # base / server (Node) / browser (DOM) configs
  copy-static.mjs        # copies static assets into dist/public after tsc
  src/
    server.ts            # dependency-free HTTP + WS server  -> dist/server.js
    public/
      cate-host.d.ts     # ambient types for the injected `cate` global
      app.ts             # drives every layer                -> dist/public/app.js
      index.html         # the panel (external script, CSP-safe)
      style.css          # themed via cate.theme.get tokens
  dist/                  # build output (shipped in the .tgz)
```
