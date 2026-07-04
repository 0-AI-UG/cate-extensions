# Kitchen Sink

A server-backed Cate extension. Authored in TypeScript and compiled to `dist/`
by `npm run build`; dependency-free at runtime (Node `http` + raw WebSocket
frames), so the shipped `.tgz` carries only compiled JS.

It is a dev-only reference (`"dev": true` in the manifest): CI builds and
validates it, but it stays out of the published catalog. Try it via sideload
(Settings, Extensions, "Add local folder...") or a local catalog build.

It uses:

- `cate.version`, `cate.panel.id`, `cate.workspace.get`, `cate.theme.get`
- `cate.storage` get/set/keys/delete, `cate.storage.panel`, `cate.storage.onChange`
- `cate.editor.openFile`, `cate.canvas.createPanel`, `cate.panel.setTitle`, `cate.ui.notify`
- HTTP and WebSocket calls to its own server (`/api/info`, `/api/echo`, `/ws`)
- `CATE_API` reverse calls from the server (`/api/cate-roundtrip`)
- `cate.agent.run` to run one agent turn (`/api/agent-run`, needs the `agent` scope)

Cate injects `PORT`, `CATE_TOKEN`, `WORKSPACE_ROOT`, and `CATE_API`. Every
request except `/health` requires `Authorization: Bearer ${CATE_TOKEN}`; the
proxy injects it, the page never holds it. All page fetch/WS use relative URLs
so they tunnel through the proxy.

The frontend-only counterpart is [`cate.frontendkit`](../cate.frontendkit).

## Build

```bash
npm install   # once, for the TypeScript toolchain (dev-only)
npm run build # compiles src/ -> dist/
```

`build.sh` runs this and tars only `manifest.json` + `dist/`.

## Layout

```
cate.kitchensink/
  manifest.json     # server: node dist/server.js
  package.json
  tsconfig*.json
  copy-static.mjs   # copies static assets into dist/public after tsc
  src/
    server.ts       # HTTP + WS server   -> dist/server.js
    public/
      cate-host.d.ts
      app.ts        # the panel           -> dist/public/app.js
      index.html
      style.css
  dist/             # build output (shipped in the .tgz)
```
