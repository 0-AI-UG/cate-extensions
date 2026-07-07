// =============================================================================
// cate.mcp extension server entry point.
//
// Cate spawns this (manifest.server) and injects env:
//   PORT           free loopback port; we MUST bind 127.0.0.1
//   HOST           127.0.0.1 (bind host)
//   CATE_TOKEN     bearer the proxy injects on every request it forwards to us
//   WORKSPACE_ROOT project root on the runtime host (.cate/mcp.json lives there)
//
// The same token also gates the aggregated /mcp endpoint for external MCP
// clients connecting directly to the loopback port.
// =============================================================================

import http from 'http'
import path from 'path'
import { Manager } from './manager'
import { Aggregator } from './aggregate'
import { ActivityLog } from './activity'
import { RegistryClient } from './registry-client'
import { AgentInstaller } from './agent-install'
import { createRequestHandler } from './http-app'

const PORT = Number(process.env.PORT)
const HOST = process.env.HOST || '127.0.0.1'
const TOKEN = process.env.CATE_TOKEN || ''
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || ''

if (!PORT) {
  console.error('cate.mcp: PORT not set by Cate; refusing to start')
  process.exit(1)
}
if (!WORKSPACE_ROOT) {
  console.error('cate.mcp: WORKSPACE_ROOT not set; refusing to start (config lives in the workspace)')
  process.exit(1)
}

const manager = new Manager({ workspaceRoot: WORKSPACE_ROOT, port: PORT, token: TOKEN })
const activityLog = new ActivityLog()
const aggregator = new Aggregator(manager, activityLog)
manager.onInventoryChange(() => aggregator.notifyListsChanged())
const registry = new RegistryClient()
const installer = new AgentInstaller(WORKSPACE_ROOT)

const handler = createRequestHandler({
  manager,
  aggregator,
  registry,
  installer,
  token: TOKEN,
  publicDir: path.join(__dirname, 'public'),
})

const server = http.createServer(handler)

// Bind first so Cate's /health probe succeeds immediately; connecting to the
// configured servers happens in the background right after.
server.listen(PORT, HOST, () => {
  console.log(`cate.mcp listening on ${HOST}:${PORT} (workspace: ${WORKSPACE_ROOT})`)
  void manager.init()
})

async function shutdown(): Promise<void> {
  await aggregator.close().catch(() => undefined)
  await manager.shutdown().catch(() => undefined)
  server.close()
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())
