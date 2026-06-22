// =============================================================================
// Task Master board server.
//
// Why a server (not frontend-only): the cateHost reverse API has NO file-read
// for arbitrary project files (editor.openFile is write-only / opens in the
// editor; workspace.get yields only rootPath). The panel must read the project's
// `.taskmaster/tasks/tasks.json`, so we ship a tiny server that Cate spawns with
// WORKSPACE_ROOT injected, reads the tasks file, and serves both the panel build
// and a JSON API to the webview. Dependency-free at runtime (Node http only).
//
// Cate injects env (see docs/extensions.md "Lifecycle"):
//   PORT           free loopback port; we MUST bind 127.0.0.1
//   HOST           127.0.0.1 (bind host)
//   CATE_TOKEN     bearer the proxy injects on every request it forwards to us
//   WORKSPACE_ROOT project root on the runtime host
//
// Routes (all but /health require Authorization: Bearer <CATE_TOKEN>):
//   GET /health        readiness probe (auth-exempt)
//   GET /              panel HTML (dist/public/index.html)
//   GET /<asset>       built JS/CSS/asset files under dist/public
//   GET /api/board     parsed board { ok, initialized, board?, path, mtime }
// =============================================================================

import http from 'http'
import fs from 'fs'
import path from 'path'
import {
  parseBoardText,
  TASKS_RELATIVE_PATH,
  LEGACY_TASKS_RELATIVE_PATH,
  type Board,
} from './shared/taskmaster'

const PORT = Number(process.env.PORT)
const HOST = process.env.HOST || '127.0.0.1'
const TOKEN = process.env.CATE_TOKEN || ''
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || ''

if (!PORT) {
  console.error('taskmaster: PORT not set by Cate; refusing to start')
  process.exit(1)
}

// --- auth --------------------------------------------------------------------

function authorized(req: http.IncomingMessage): boolean {
  const header = String(req.headers['authorization'] || '')
  return TOKEN.length > 0 && header === `Bearer ${TOKEN}`
}

// --- task file reading -------------------------------------------------------

interface BoardResult {
  ok: boolean
  /** true when a .taskmaster tasks file exists (even if empty/corrupt). */
  initialized: boolean
  /** Parsed board, or null when missing/corrupt. */
  board: Board | null
  /** Absolute path we read (or attempted), for display/debugging. */
  path: string | null
  /** Last-modified epoch ms, used by the client to poll for changes cheaply. */
  mtime: number | null
  error?: string
}

/** Resolve the tasks file path under the workspace root, preferring the
 *  canonical `.taskmaster/tasks/tasks.json`, falling back to the legacy path. */
function resolveTasksFile(): string | null {
  if (!WORKSPACE_ROOT) return null
  const canonical = path.join(WORKSPACE_ROOT, TASKS_RELATIVE_PATH)
  if (fs.existsSync(canonical)) return canonical
  const legacy = path.join(WORKSPACE_ROOT, LEGACY_TASKS_RELATIVE_PATH)
  if (fs.existsSync(legacy)) return legacy
  // Even if neither exists yet, report the canonical path so the empty state can
  // tell the user exactly where Task Master would write.
  return canonical
}

function readBoard(): BoardResult {
  const file = resolveTasksFile()
  if (!file) {
    return { ok: false, initialized: false, board: null, path: null, mtime: null, error: 'no-workspace' }
  }
  let stat: fs.Stats
  try {
    stat = fs.statSync(file)
  } catch {
    // No file: project simply hasn't run `task-master init` / parse-prd.
    return { ok: true, initialized: false, board: null, path: file, mtime: null }
  }
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    return {
      ok: false,
      initialized: true,
      board: null,
      path: file,
      mtime: stat.mtimeMs,
      error: err instanceof Error ? err.message : String(err),
    }
  }
  const board = parseBoardText(text)
  return { ok: true, initialized: true, board, path: file, mtime: stat.mtimeMs }
}

// --- static assets -----------------------------------------------------------

const PUBLIC_DIR = path.join(__dirname, 'public')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

// External script only (no inline), allow same-origin fetch through the proxy.
const PAGE_CSP =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "font-src 'self' data:; " +
  "connect-src 'self'; " +
  'frame-ancestors *'

/** Resolve a request path to a file under PUBLIC_DIR, guarding against
 *  traversal. Returns null when the resolved path escapes PUBLIC_DIR. */
function resolveAsset(pathname: string): string | null {
  const rel = pathname === '/' || pathname === '' ? 'index.html' : pathname.replace(/^\/+/, '')
  const abs = path.join(PUBLIC_DIR, rel)
  const normalized = path.normalize(abs)
  if (normalized !== PUBLIC_DIR && !normalized.startsWith(PUBLIC_DIR + path.sep)) return null
  return normalized
}

function sendJson(res: http.ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const pathname = url.pathname

  // Readiness probe, auth-exempt so Cate's probe (no token yet) succeeds.
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('ok')
    return
  }

  // Everything else requires the injected bearer token.
  if (!authorized(req)) {
    res.writeHead(401, { 'Content-Type': 'text/plain' })
    res.end('Unauthorized')
    return
  }

  if (pathname === '/api/board' && req.method === 'GET') {
    sendJson(res, 200, readBoard())
    return
  }

  // Static panel assets (index.html + built JS/CSS).
  const asset = resolveAsset(pathname)
  if (!asset) {
    res.writeHead(403).end('Forbidden')
    return
  }
  let data: Buffer
  try {
    data = fs.readFileSync(asset)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found')
    return
  }
  const ext = path.extname(asset).toLowerCase()
  const headers: Record<string, string> = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  }
  // The served HTML carries the strict CSP; assets just get the type.
  if (ext === '.html') headers['Content-Security-Policy'] = PAGE_CSP
  res.writeHead(200, headers)
  res.end(data)
})

server.listen(PORT, HOST, () => {
  console.log(`taskmaster listening on ${HOST}:${PORT} (workspace: ${WORKSPACE_ROOT || '(none)'})`)
})
