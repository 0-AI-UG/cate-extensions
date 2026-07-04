// =============================================================================
// cate.sqlite viewer server.
//
// Cate spawns this and injects env:
//   PORT           free loopback port to bind on 127.0.0.1 (Cate's contract)
//   HOST           127.0.0.1 (we bind exactly this)
//   CATE_TOKEN     bearer the proxy injects on every request to us
//   WORKSPACE_ROOT workspace root path on the runtime host
//
// What it does:
//   - Binds PORT on 127.0.0.1.
//   - GET /health (auth-exempt) — Cate's readiness probe.
//   - GET / + /assets/* — the panel shell page and its bundled JS/CSS.
//   - GET/POST /api/* — JSON: list databases, read a table page, run a
//     read-only query, rescan the workspace.
//
// Unlike the old Datasette wrapper there is no child process: SQLite is read
// in-process via a bundled WASM engine (src/db.ts), so nothing is installed or
// spawned and the reads never touch the files on disk.
// =============================================================================

import http from 'http'
import fs from 'fs'
import path from 'path'
import { findSqliteFiles } from './scan'
import { listTables, readTable, runQuery, clearCache, type TableInfo } from './db'
import {
  sendJson,
  readBody,
  isAuthorized,
  sendBytes,
  handleHealth,
  sendUnauthorized,
  PANEL_CSP,
} from './_kitserver/http'

const PORT = Number(process.env.PORT)
const TOKEN = process.env.CATE_TOKEN || ''
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || ''

if (!PORT) {
  console.error('cate.sqlite: PORT not set by Cate; refusing to start')
  process.exit(1)
}

// --- workspace database index --------------------------------------------------

interface DbEntry {
  /** Workspace-relative path, the stable id the panel passes back in `db`. */
  relPath: string
  /** Absolute path on the runtime host (never sent to the panel). */
  absPath: string
  /** Basename, for display. */
  name: string
}

// Lazily-scanned index of workspace databases, keyed by relPath. Rebuilt on the
// first request and on an explicit rescan.
let index: Map<string, DbEntry> | null = null

function relOf(abs: string): string {
  const rel = WORKSPACE_ROOT ? path.relative(WORKSPACE_ROOT, abs) : abs
  return rel.split(path.sep).join('/')
}

function scanWorkspace(): Map<string, DbEntry> {
  const map = new Map<string, DbEntry>()
  const files = WORKSPACE_ROOT ? findSqliteFiles(WORKSPACE_ROOT) : []
  for (const abs of files) {
    const relPath = relOf(abs)
    map.set(relPath, { relPath, absPath: abs, name: path.basename(abs) })
  }
  return map
}

function ensureIndex(): Map<string, DbEntry> {
  if (!index) index = scanWorkspace()
  return index
}

function rescan(): Map<string, DbEntry> {
  clearCache()
  index = scanWorkspace()
  return index
}

/** Resolve a panel-supplied `db` (relPath) to its indexed entry, or null. Never
 *  trusts the value as a path — only known-scanned databases resolve. */
function resolveDb(rel: unknown): DbEntry | null {
  if (typeof rel !== 'string') return null
  return ensureIndex().get(rel) ?? null
}

// --- static assets -------------------------------------------------------------

interface StaticAsset {
  file: string
  type: string
}

// The panel's own bundle. URLs are remapped (/assets/app.js -> public/app.js)
// rather than served straight from a root dir, so this stays a small table
// instead of the kit's generic serveStaticFile.
const SHELL_STATIC: Record<string, StaticAsset> = {
  '/assets/app.js': { file: 'public/app.js', type: 'text/javascript; charset=utf-8' },
  '/assets/app.css': { file: 'public/app.css', type: 'text/css; charset=utf-8' },
}

function readPublic(rel: string): Buffer {
  return fs.readFileSync(path.join(__dirname, rel))
}

// The shell renders SQLite data straight into the DOM (no iframe, no external
// origins), so the kit's tight PANEL_CSP (own scripts + inline styles) applies.
function sendShell(res: http.ServerResponse): void {
  sendBytes(res, readPublic('public/index.html'), 'text/html; charset=utf-8', PANEL_CSP)
}

// --- API handlers --------------------------------------------------------------

/** Databases + their table/view lists (one cheap schema query each). */
async function databasesPayload(): Promise<Record<string, unknown>> {
  const entries = [...ensureIndex().values()]
  const databases = []
  for (const entry of entries) {
    let tables: TableInfo[]
    let error: string | undefined
    try {
      tables = await listTables(entry.absPath)
    } catch (err) {
      tables = []
      error = err instanceof Error ? err.message : String(err)
    }
    let size = 0
    try {
      size = fs.statSync(entry.absPath).size
    } catch {
      /* unreadable — report 0 */
    }
    databases.push({ name: entry.name, relPath: entry.relPath, size, tables, error })
  }
  return { workspaceRoot: WORKSPACE_ROOT || null, databases }
}

async function handleTable(url: URL, res: http.ServerResponse): Promise<void> {
  const entry = resolveDb(url.searchParams.get('db'))
  if (!entry) {
    sendJson(res, 404, { error: 'Unknown database' })
    return
  }
  const table = url.searchParams.get('table')
  if (!table) {
    sendJson(res, 400, { error: 'Missing table' })
    return
  }
  try {
    const page = await readTable(entry.absPath, table, {
      limit: url.searchParams.get('limit'),
      offset: url.searchParams.get('offset'),
      orderBy: url.searchParams.get('orderBy'),
      dir: url.searchParams.get('dir'),
    })
    sendJson(res, 200, { db: entry.relPath, table, ...page })
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleQuery(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let body: { db?: unknown; sql?: unknown }
  try {
    body = JSON.parse((await readBody(req)) || '{}')
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' })
    return
  }
  const entry = resolveDb(body.db)
  if (!entry) {
    sendJson(res, 404, { error: 'Unknown database' })
    return
  }
  if (typeof body.sql !== 'string' || !body.sql.trim()) {
    sendJson(res, 400, { error: 'Missing sql' })
    return
  }
  try {
    const result = await runQuery(entry.absPath, body.sql)
    sendJson(res, 200, { db: entry.relPath, ...result })
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
  }
}

// --- HTTP server ---------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const pathname = url.pathname

  // Readiness probe, auth-exempt so Cate's probe (no token yet) succeeds.
  if (handleHealth(req, res)) return

  if (!isAuthorized(req, TOKEN)) {
    sendUnauthorized(res)
    return
  }

  // Shell page at the panel root.
  if (pathname === '/' || pathname === '') {
    sendShell(res)
    return
  }

  // Wrapper-owned static assets.
  const asset = SHELL_STATIC[pathname]
  if (asset) {
    try {
      sendBytes(res, readPublic(asset.file), asset.type)
    } catch {
      res.writeHead(404).end('Not found')
    }
    return
  }

  // --- JSON API ---
  if (pathname === '/api/databases' && req.method === 'GET') {
    sendJson(res, 200, await databasesPayload())
    return
  }
  if (pathname === '/api/table' && req.method === 'GET') {
    await handleTable(url, res)
    return
  }
  if (pathname === '/api/query' && req.method === 'POST') {
    await handleQuery(req, res)
    return
  }
  if (pathname === '/api/rescan' && req.method === 'POST') {
    rescan()
    sendJson(res, 200, await databasesPayload())
    return
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('Not found')
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(
    `cate.sqlite viewer listening on 127.0.0.1:${PORT} (workspace: ${WORKSPACE_ROOT || '(none)'})`,
  )
})
