# MCPHub

Manage and orchestrate multiple MCP servers from a panel on the Cate canvas,
backed by [MCPHub](https://github.com/samanhappy/mcphub). The panel embeds
MCPHub's web dashboard, reverse-proxied through a loopback-bound wrapper.

This is a **server-backed** Cate extension. The server (`dist/server.js`) is a
small, dependency-free wrapper that satisfies Cate's contract (bind `127.0.0.1`,
serve `/health`, token gate) and proxies to a MCPHub instance it launches.

## Why a wrapper

MCPHub reads `PORT` (default 3000) and `BASE_PATH`, but it binds `0.0.0.0`
(ignores `HOST`) and has no `/health` route — so it can't be Cate's server
directly. The wrapper binds Cate's `PORT` on loopback, exposes `/health`, serves
a themed loader/shell at `/`, and reverse-proxies the dashboard (mounted under
MCPHub's `BASE_PATH=/__mcphub/dash`) plus its WebSocket/SSE transport.

## Providing MCPHub

The wrapper resolves MCPHub in this order:

1. `MCPHUB_CMD` env (e.g. `MCPHUB_CMD="docker run --rm -p ${PORT}:${PORT} samanhappy/mcphub"`)
2. `mcphub` on `PATH` (`npm i -g @samanhappy/mcphub`)
3. `npx -y @samanhappy/mcphub`

If none is found, the panel shows install instructions.

## Build

```bash
npm install   # dev toolchain only (TypeScript + vitest)
npm run build # src/ -> dist/
npm test      # vitest
```

Only `manifest.json` + `dist/` ship in the catalog artifact.

## Layout

```
cate.mcphub/
  manifest.json        # server: node dist/server.js, readyPath /health
  src/
    server.ts          # wrapper: /health, shell, proxy -> dist/server.js
    mcphub.ts          # MCPHub resolution + child env
    proxy.ts           # HTTP/WS proxy + readiness probe
    *.test.ts          # vitest
    public/
      shell.html, app.ts, style.css, cate-host.d.ts
  dist/                # build output (shipped)
  STATUS.md            # license finding + implementation status
```

See `STATUS.md` for the license verdict, what's implemented vs documented, and
the Cate-agent ↔ MCPHub integration notes.
