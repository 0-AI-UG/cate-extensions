# STATUS: cate.mcp

## 1. Approach

A **server-backed extension** (`manifest.server`), like cate.taskmaster and for
the same reason: the manager must read/write `.cate/mcp.json` in the workspace,
spawn and supervise child processes, hold outbound MCP connections, and host
the aggregated `/mcp` endpoint; none of that is possible from the sandboxed
webview. Cate spawns `node dist/server.js` with `PORT`/`HOST`/`CATE_TOKEN`/
`WORKSPACE_ROOT` injected; every route except `/health` and `/oauth/callback`
requires the bearer token (`/oauth/callback` is authenticated by the
single-use OAuth `state` parameter instead, since a browser redirect cannot
carry the bearer).

The only runtime dependency beyond React is the official
`@modelcontextprotocol/sdk` (pinned `^1.29.0`, pure JS). It is bundled into
`dist/server.js` with esbuild (Node builtins external), so the shipped
artifact is `manifest.json + dist/` with no `node_modules` and runs on bare
Node. Verified: the only bare `require()`s left in the bundle are Node
builtins (the `require("ajv/...")` strings inside are ajv standalone-codegen
string templates, not real imports), and the smoke test runs the built bundle
directly.

## 2. Implemented and verified

- **Config model** (`src/shared/config.ts` + `src/server/config-store.ts`):
  Claude-Desktop-style `mcpServers`, per-server `disabled`, name validation
  (`__` rejected, it is the namespacing separator), `${env:VAR}` expansion at
  launch only (missing vars are a launch error, never silently empty),
  unknown-key preservation through all mutations (mutate-the-parsed-doc, JSON
  level), atomic temp+rename writes with mtime conflict 409, corrupt files
  surfaced (and mutations blocked with 409) while the watcher keeps looking
  for recovery. External edits hot-apply via diff: only added/changed/removed
  servers are touched.
- **Lifecycle** (`src/server/connection.ts`, `src/server/manager.ts`):
  per-server connection wrapper on the SDK `Client`. stdio via
  `StdioClientTransport` with `stderr: 'pipe'` (bounded 100-line tail, reset
  per run); remote via `StreamableHTTPClientTransport` with
  `SSEClientTransport` fallback (both attempts reported on failure).
  Supervision follows the cate.datasette conventions: monotonic generation id
  guarding every async step and event, handshake timeout that reaps the stuck
  child, SIGKILL escalation after close, synchronous SIGKILL backstop on
  process exit. Crash auto-restart with capped exponential backoff
  ("restarting (n)"), give-up after 8 attempts, counter reset after a stable
  run. Periodic `ping()` drives running/degraded. All covered by tests against
  a REAL spawned fixture MCP server, including a crash-and-recover cycle, a
  keeps-dying give-up, a stale-exit generation-guard race, and stop-cancels-
  pending-retry.
- **Inventory**: listTools/listResources/listPrompts, capability-gated,
  paginated, refreshed on `list_changed` notifications.
- **Playground**: schema-to-form classifier (flat string/number/integer/
  boolean/enum objects become forms; everything else a validated JSON editor),
  result rendering by content type, duration, per-session history; resource
  read by URI; prompt get with arguments. Classifier and coercion unit-tested;
  passthrough tested end to end against the fixture.
- **Unified endpoint** (`src/server/aggregate.ts`): SDK `Server` +
  `StreamableHTTPServerTransport` (session-per-client) at `/mcp`, tools and
  prompts namespaced `<server>__<name>` split on the FIRST `__` (deterministic
  because server names cannot contain `__`), upstream errors returned as tool
  errors (session survives, verified), `listChanged` fan-out on inventory or
  server-set changes. Tested with InMemoryTransport upstreams AND over real
  HTTP with a real SDK client through the token gate.
- **Registry browser** (`src/server/registry-client.ts`,
  `src/shared/registry.ts`): `GET /v0/servers?search=&version=latest&limit=30
  &cursor=` against registry.modelcontextprotocol.io, verified against the
  LIVE API and its OpenAPI spec (response shape
  `{servers:[{server,_meta}],metadata:{nextCursor}}`). In-memory TTL cache,
  10s timeout, failures confined to the Discover tab. Add prefill from npm
  (npx), pypi (uvx) and oci (docker) packages incl. runtime/package arguments
  and environment variables, or from a streamable-http remote; unresolved
  required inputs are listed for the user.
- **OAuth** (`src/server/oauth.ts`): full `OAuthClientProvider`
  implementation; PKCE flow with the redirect URI hosted at
  `GET /oauth/callback`; single-use expiring `state` registry; tokens/client
  info/verifier in `.cate/mcp-auth.json` written 0600, `.cate/.gitignore`
  gets `mcp-auth.json` idempotently; token refresh via the SDK provider hooks;
  `finishAuth` on callback then reconnect. Storage, provider hooks, state
  registry and gitignore idempotency are unit-tested.
- **HTTP API** (`src/server/http-app.ts`): the full route set from the spec
  with a tested validation matrix (401 wrong/missing token, 400 malformed
  bodies/names/configs, 404 unknown server/route, 409 duplicate add, disabled
  start, not-running playground call, corrupt-config mutation, concurrent
  write).
- **Panel** (`src/public/`): Servers tab (endpoint card, status badges with
  uptime and tool counts, row actions with inline failure surfacing, delete
  confirm, cross-server inventory search that deep-links into a tool's
  playground), detail drawer (handshake info, capabilities, stderr tail,
  inventory + playground, per-session history, OAuth connect), add/edit drawer
  (stdio/remote toggle, args one-per-line, env/headers KV editors, `__` name
  validation), Discover tab with pagination and offline error state, friendly
  first-run empty state, full config-error state that recovers automatically.
  Polls `/api/state` every 2s gated by a monotonic serial (the numbered-id
  convention). Kit-themed via `--cate-*` tokens.

**Verification gate:** `npm test` (9 files, 88 tests) passes; `npm run
typecheck` (browser + server + test configs) clean; `npm run build` clean;
`node scripts/sync-kit.mjs --check` clean; `./build.sh` builds the catalog
with `cate.mcp@1.0.0` and a clean artifact (manifest + dist only). A live
smoke test of the BUILT `dist/server.js` (spawned with only PORT/HOST/
CATE_TOKEN/WORKSPACE_ROOT): health probe, 401 without token, panel HTML
served, server added via API (config file materialized correctly), autostart
to `running` with handshake/inventory, playground echo call, then an SDK
client against `/mcp` listing `smoke__*` tools, calling `smoke__echo` and
`smoke__add` through the aggregator, and receiving `smoke__fail` as
`isError: true`. Child process reaped on SIGTERM (verified via pgrep).

## 3. Stubbed / limitations (and why)

- **OAuth end-to-end** needs a real authorization server plus a user agent, so
  the interactive leg is not integration-tested; the provider, persistence,
  state registry and callback validation are unit/API-tested and the flow is
  wired exactly along the SDK's documented `UnauthorizedError`/`finishAuth`
  path. Deviation from the brief: the cateHost API has no open-external call
  (checked `kit/cate-host.d.ts`), so the panel renders the authorization URL
  as a prominent `target="_blank"` link plus a copy button.
- **Resource namespacing at `/mcp`**: resource NAMES are namespaced
  `<server>__<name>`, but URIs are passed through unchanged and reads are
  routed by URI ownership from the cached inventories (first owner wins on a
  duplicate URI). Rewriting URIs would break clients that treat them as
  opaque-but-meaningful (templates, relative refs); this keeps them usable.
- **Registry add** covers npm/pypi/oci packages and remotes; other
  `registryType`s (nuget, mcpb) have no no-install runner, so the panel says
  "add manually" for those entries.
- **Aggregator sessions are in-memory**: a restart of the extension server
  drops MCP sessions; clients reconnect (standard streamable-HTTP behavior).
- **`degraded` relies on `ping()`**: a server that ignores pings but otherwise
  works would flap to degraded; ping failures never kill the connection, so
  this is cosmetic and honest.
- The stdio fixture and smoke client live under `src/test/` and import the SDK
  from dev `node_modules`; they never ship in the artifact.

## 4. Build / run

```bash
npm install
npm run build      # vite panel -> dist/public, esbuild server -> dist/server.js (self-contained)
npm test
npm run typecheck
```

Manual run outside Cate:

```bash
PORT=39231 HOST=127.0.0.1 CATE_TOKEN=dev WORKSPACE_ROOT=$PWD node dist/server.js
```

## 5. Shared-file registration a human must apply

**None in Cate.** In cate-extensions, exactly one shared-file edit was made,
as sanctioned by the task: `cate.mcp` added to `KIT_CONSUMERS` in
`scripts/sync-kit.mjs` (plus the generated `src/_kit/` copies it syncs).
`build.sh` auto-discovers the folder; `cate.mcphub` was not touched.
