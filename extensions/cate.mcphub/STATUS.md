# cate.mcphub — implementation status

Wrapper that runs **MCPHub** (https://github.com/samanhappy/mcphub) as a
server-backed Cate extension and embeds its dashboard in a canvas panel.

## 1. License finding (gate)

**Verdict: clear to ship a wrapper; bundling the MCPHub runtime is not done.**

- MCPHub's repo `LICENSE` is **Apache-2.0**; its published npm package
  `@samanhappy/mcphub` (latest **1.0.17**) declares **ISC** in `package.json`.
  Both are permissive (commercial use, redistribution, modification, and
  sublicensing all allowed). Apache-2.0 adds attribution/NOTICE and a patent
  grant; neither is copyleft. **No clause blocks bundling or shipping** inside
  Cate's permissive catalog.

- Despite the permissive license, **this extension does NOT bundle MCPHub.** Two
  practical reasons, not legal ones:
  1. MCPHub has ~90 runtime dependencies and native build steps. Cate's catalog
     artifact ships **only `manifest.json` + `dist/`** (no runtime
     `node_modules`; see `cate-extensions/build.sh`), so a self-contained
     MCPHub cannot ride along.
  2. MCPHub is a stateful service the user typically configures with their own
     MCP servers, credentials, and `mcp_settings.json`. Pinning/vendoring it
     inside Cate would fight the user's own install.

  So the extension uses a **connect-to-(or-launch-)user-instance model**: it
  resolves a MCPHub the user has available and supervises it. This is the same
  model the neighboring `cate.sourcebot` extension uses, and is documented
  below. If full bundling is ever wanted, the license permits it (attach
  MCPHub's `LICENSE`/`NOTICE`); it's a packaging decision, not a legal one.

## 2. What this extension is

Cate's server contract requires the extension server to **bind `127.0.0.1`** and
expose a **`readyPath`**. MCPHub does **neither**: it reads `PORT` (default 3000)
and `BASE_PATH`, but its Express server calls `app.listen(port)` with **no host**
(so it binds `0.0.0.0`, ignoring `HOST`) and has **no `/health` route**
(verified against `src/server.ts` / `src/config/index.ts` on `main`).

So Cate's `server.command` is **not** MCPHub directly. It's a small,
dependency-free **wrapper** (`dist/server.js`) that:

- Binds Cate's injected `PORT` on `127.0.0.1` (contract + token gate satisfied).
- Serves `GET /health` (auth-exempt) for Cate's readiness probe.
- Serves a themed **shell page** at `/` (loader, status, error/retry UI) styled
  from `cate.theme.get()`.
- **Lazily spawns MCPHub** on a private free loopback port with
  `PORT=<internal>` and `BASE_PATH=/__mcphub/dash`, then **reverse-proxies**
  (HTTP + WebSocket/SSE upgrades) everything under `/__mcphub/dash` to it. The
  shell embeds that path in an iframe. Mounting MCPHub under its own `BASE_PATH`
  means all its absolute-path assets/API route cleanly through the proxy with no
  URL rewriting.

## 3. Implemented vs stubbed

| Area | State |
| --- | --- |
| Manifest (`server`, `readyPath: /health`, `portEnv: PORT`, scopes) | Implemented |
| Wrapper: bind 127.0.0.1, `/health`, token gate, shell page | Implemented, tested live |
| MCPHub resolution (`MCPHUB_CMD` → `mcphub` on PATH → `npx @samanhappy/mcphub`) | Implemented, unit-tested |
| Child env: force internal `PORT`, set `BASE_PATH`, strip `CATE_TOKEN`/`CATE_API`, pass through user config/creds | Implemented, unit-tested |
| Readiness probe (any HTTP status = up; MCPHub has no /health) | Implemented, tested |
| Reverse proxy HTTP + WS/SSE upgrade | HTTP implemented + tested; WS/SSE upgrade implemented (forwarding tested for HTTP; live SSE not exercised here) |
| Fast-fail on child spawn error/early exit (no 45s hang) | Implemented, tested live |
| Crash/exit surface: captured stderr tail in `/__mcphub/status`, retry button | Implemented |
| Cate glue: `cate.theme.get` theming, `cate.ui.notify` status, `cate.storage.panel` last-status, `cate.panel.setTitle` | Implemented |
| Cate agent ↔ MCPHub-managed MCP servers integration | **Documented, not built** — see §6 |
| Tests (Vitest) | 15 passing (`mcphub.test.ts`, `proxy.test.ts`) |

Verified live against a fake MCPHub (honoring `PORT`/`BASE_PATH`):
`/health`→200, unauth→401, shell at `/`, `/__mcphub/start`→ready, dashboard +
asset proxied under `/__mcphub/dash`, non-dash→404, bad-binary→fast ENOENT error.
**Not** verified against the real MCPHub binary (not installed in this
environment) — the wrapper contract is the same, so this is the remaining
real-world step.

## 4. Runtime requirements

The user (or their environment) must provide MCPHub one of these ways, resolved
in order:

1. `MCPHUB_CMD` env var — any launch command, e.g.
   `MCPHUB_CMD="docker run --rm -p ${PORT}:${PORT} samanhappy/mcphub"` or
   `MCPHUB_CMD="node /path/to/mcphub/dist/index.js"`. Highest priority.
2. `mcphub` on `PATH` — i.e. `npm i -g @samanhappy/mcphub` (or a linked dev
   checkout). Provides the `mcphub` bin.
3. `npx` on `PATH` — falls back to `npx -y @samanhappy/mcphub` (first run
   downloads the package into the npx cache).

If none resolves, the panel shows an actionable error with install instructions
(no cryptic spawn failure). MCPHub itself wants Node and, optionally, an
`mcp_settings.json` and `ADMIN_PASSWORD` (it prints a generated password to
stderr if unset — captured and shown in the panel's status logs).

## 5. Build / run

```bash
cd cate-extensions/extensions/cate.mcphub
npm install     # dev toolchain only (TypeScript, vitest)
npm run build   # src/ -> dist/ (server + proxy + mcphub + public assets)
npm test        # vitest, 15 tests
```

`cate-extensions/build.sh` compiles this like any TS extension and ships only
`manifest.json` + `dist/` in the artifact (no runtime `node_modules` — the
wrapper is dependency-free, Node `http`/`net`/`child_process` only). Sideload the
folder in Cate (Settings → Extensions) for local dev.

## 6. Cate agent ↔ MCPHub integration (designed, not built)

MCPHub aggregates many MCP servers and re-exposes them as **grouped MCP
endpoints** (SSE/streamable-HTTP) under its base path, e.g. a "smart routing"
endpoint and per-group endpoints. Cate's bundled agent (pi) consumes MCP
servers via its own config. The natural bridge:

1. The wrapper already knows MCPHub's reverse-proxied base
   (`/__mcphub/dash`). It can call MCPHub's API (e.g. its servers/groups list)
   and write a normalized summary to **`cate.storage`** (extension-scoped), so
   Cate or the user can see which MCP servers MCPHub exposes.
2. To actually feed Cate's agent, Cate would point pi at MCPHub's aggregated MCP
   endpoint URL (a single MCP server entry that fans out to all of MCPHub's).
   That endpoint is loopback + token-gated, so it must be wired through Cate's
   own MCP config plumbing — which lives in Cate `src/` and is **out of scope
   for this extension** (constraint: confine changes to this folder).

**Why not built now:** writing the agent's MCP config is a host-side concern
(Cate `src/`), and exposing MCPHub's aggregated endpoint to pi needs Cate to
accept a token-gated loopback MCP URL. Both are host changes, not extension
changes. The extension is built to make this easy later: the wrapper can publish
MCPHub's endpoint/group info to `cate.storage` for the host to pick up. If
desired as a follow-up, the smallest viable step is a wrapper route
(`/__mcphub/mcp-endpoints`) that returns MCPHub's aggregated MCP URL(s); Cate
then offers a one-click "use in agent".

## 7. Shared-file registration a human must apply

**None required inside Cate's `src/`.** This extension follows the manifest +
catalog contract and needs no host code changes. To publish:

- Land this folder in the `cate-extensions` repo via PR (the trust boundary is
  PR review; servers run unsandboxed, so review the wrapper as a security
  review). CI's `build.sh` picks it up automatically (any folder under
  `extensions/` with a `manifest.json`) and regenerates the catalog index — **no
  manual registry edit.**
- No edits to Cate's `src/shared/extensions.ts`, `cateApiHandlers.ts`, etc.: the
  manifest declares only existing `cateApi` scopes (`theme`, `ui`, `storage`,
  `workspace.read`).

### Security note

MCPHub binds `0.0.0.0` on its internal port (it ignores `HOST`). The wrapper
runs it on a **random ephemeral port** and only ever connects via `127.0.0.1`,
and the wrapper itself binds `127.0.0.1` behind Cate's token gate. The residual
exposure is MCPHub listening on all interfaces on that random internal port for
the panel's lifetime — same caveat as running MCPHub locally by hand. A future
hardening (upstream `HOST` support in MCPHub, or a firewall/namespace) would
close it; it cannot be fixed from the wrapper without patching MCPHub.
