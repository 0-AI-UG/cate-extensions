# MCP Servers (cate.mcp)

A native MCP server manager for Cate: configure, supervise and explore Model Context Protocol servers per workspace, and expose them all through one aggregated MCP endpoint.

Built directly on the official [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk); no third-party hub in between.

## What it does

- **Dashboard (default view)**: server health at a glance plus a live Activity feed. An endpoint strip (live dot, URL, server/tool counts), a stat row (running / degraded / needs-auth, total tools, and recent calls/errors — labelled "recent" since the feed is a bounded ~200-entry ring), a servers health grid (status, tool count, uptime), and a newest-first feed of every tool call through the aggregated endpoint (`time · server__tool · caller · duration · ok/err`), self-refreshed every 2s from `GET /api/activity`. The panel opens here.

- **Workspace config in `.cate/mcp.json`**, Claude-Desktop-style and hand-editable:

  ```json
  {
    "mcpServers": {
      "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
      "linear": { "url": "https://mcp.linear.app/mcp" },
      "flaky": { "command": "…", "disabled": true }
    }
  }
  ```

  External edits are watched and hot-applied (only changed servers restart). Panel edits write back atomically with conflict detection and preserve unknown keys byte-for-byte at the JSON level. `${env:VAR}` placeholders in command/args/env/cwd/url/headers expand at launch time and are never written back expanded.

- **Lifecycle supervision**: stdio servers are spawned and supervised with generation-guarded state (a replaced run can never clobber its successor), crash detection with capped exponential backoff auto-restart, SIGTERM to SIGKILL escalation plus a process-exit SIGKILL backstop, and a bounded per-run stderr tail. Remote servers connect over streamable HTTP with SSE fallback. Health is the initialize handshake plus periodic `ping()`; failures show as `degraded`. Statuses: stopped, starting, running, degraded, restarting (n), error, needs-auth, disabled.

- **Inventory**: tools, resources and prompts per running server (only what the server's capabilities advertise), refreshed on `list_changed` notifications, searchable across all servers.

- **Tool playground**: flat JSON schemas become a generated form; anything else gets a validated raw-JSON editor. Results render by content type (text, JSON, images, errors) with duration and a per-session invocation history. Resources can be read by URI and prompts fetched with arguments.

- **Unified MCP endpoint at `/mcp`**: the extension server itself is an MCP server (streamable HTTP) aggregating every tool/resource/prompt of every enabled and running managed server, deterministically namespaced `<server>__<name>`. Upstream failures come back as tool errors, never protocol crashes; `listChanged` fires when upstreams change. Auth is the same bearer token Cate injects. The panel's Endpoint card shows the URL and header with copy buttons; point any MCP client (including a coding agent) at it.

- **One-click install into coding agents**: the Endpoint screen writes this endpoint into each agent's workspace-local config — Agent panel (`.pi/mcp.json`, read by the `pi-mcp-adapter` package), Claude Code (`.mcp.json`), Cursor (`.cursor/mcp.json`), OpenCode (`opencode.json`), and Codex (`.codex/config.toml`), each in that agent's own shape, preserving every other key. Antigravity (global-only config) and PI (no MCP) are listed but disabled with the reason. The endpoint's port/token are reminted each Cate session, so an install is a snapshot: a stale entry is flagged with an Update button, and the endpoint only serves while the panel is open.

- **Discover tab**: searches the official registry at `registry.modelcontextprotocol.io` (`GET /v0/servers?search=…` with cursor pagination) and one-click prefills the add-server form from a registry entry's npm/pypi/oci package or remote URL. Registry failures stay inside that tab.

- **OAuth for remote servers**: on a 401 the server shows `needs-auth` with a Connect button; the PKCE flow runs through `GET /oauth/callback` on the extension's loopback port. Tokens live in `.cate/mcp-auth.json` (mode 0600, auto-gitignored via `.cate/.gitignore`), never in `mcp.json`; refresh is handled through the SDK provider hooks.

## Build

```bash
npm install
npm run build      # vite (panel) -> dist/public, esbuild (server bundle) -> dist/server.js
npm test           # vitest: 113 tests
npm run typecheck  # browser + server + test tsconfigs
```

The server bundle is fully self-contained (SDK bundled, Node builtins external): `node dist/server.js` runs on a machine with nothing but Node.

## Try it

1. `npm run build` here.
2. In Cate: Settings, Extensions, sideload this folder and enable it.
3. Open the **MCP Servers** panel. Add a server (or hit Discover), watch it start, browse its tools, call one, then copy the Endpoint card's URL into any MCP client.
