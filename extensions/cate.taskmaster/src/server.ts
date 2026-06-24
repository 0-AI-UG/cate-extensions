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
//   GET  /health         readiness probe (auth-exempt)
//   GET  /               panel HTML (dist/public/index.html)
//   GET  /<asset>        built JS/CSS/asset files under dist/public
//   GET  /api/board      parsed board { ok, initialized, board?, path, mtime }
//   POST /api/task/patch { tag, id, patch } -> update one task's fields
//   POST /api/task       { tag, task }      -> create a task (inits the file)
// =============================================================================

import http from 'http'
import fs from 'fs'
import path from 'path'
import {
  parseBoardText,
  applyTaskPatch,
  addTask,
  TASKS_RELATIVE_PATH,
  LEGACY_TASKS_RELATIVE_PATH,
  type Board,
  type TaskPatch,
  type NewTaskInput,
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

// --- task writes -------------------------------------------------------------
//
// Deterministic edits (status change, create, field edits) are done here by
// mutating the raw JSON and writing it back atomically; the generative work
// (generate-from-spec, expand-into-subtasks) is left to cate.agent editing the
// file directly. We always write back to the file we read so a project on the
// legacy path stays on it, and create the canonical path + dirs for a first task.

/** Current raw file text, or '' when no tasks file exists yet. */
function readRawText(): string {
  const file = resolveTasksFile()
  if (!file) return ''
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** Atomically write the tasks file (temp + rename), creating parent dirs. */
function writeTasksFile(text: string): { ok: true; path: string } | { ok: false; error: string } {
  const file = resolveTasksFile()
  if (!file) return { ok: false, error: 'no-workspace' }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.cate-${process.pid}.tmp`
    fs.writeFileSync(tmp, text, 'utf8')
    fs.renameSync(tmp, file)
    return { ok: true, path: file }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Read a request body as text, capped at 1 MB. */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 1_000_000) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      data += chunk.toString('utf8')
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
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
  void handle(req, res).catch((err) => {
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(err) })
    else res.end()
  })
})

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
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

  // Patch one task's fields (status change from drag, inline edits).
  if (pathname === '/api/task/patch' && req.method === 'POST') {
    let body: { tag?: string; id?: number; patch?: TaskPatch }
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid JSON body' })
      return
    }
    if (!body.tag || typeof body.id !== 'number' || !body.patch) {
      sendJson(res, 400, { ok: false, error: 'tag, id and patch are required' })
      return
    }
    const next = applyTaskPatch(readRawText(), body.tag, body.id, body.patch)
    if (next === null) {
      sendJson(res, 404, { ok: false, error: 'task not found' })
      return
    }
    const result = writeTasksFile(next)
    sendJson(res, result.ok ? 200 : 500, result)
    return
  }

  // Create a task (also initializes the file for a first task).
  if (pathname === '/api/task' && req.method === 'POST') {
    let body: { tag?: string; task?: NewTaskInput }
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid JSON body' })
      return
    }
    if (!body.tag || !body.task || !body.task.title?.trim()) {
      sendJson(res, 400, { ok: false, error: 'tag and task.title are required' })
      return
    }
    const created = addTask(readRawText(), body.tag, body.task)
    if (created === null) {
      sendJson(res, 400, { ok: false, error: 'could not add task' })
      return
    }
    const result = writeTasksFile(created.text)
    sendJson(res, result.ok ? 200 : 500, result.ok ? { ok: true, id: created.id } : result)
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
}

server.listen(PORT, HOST, () => {
  console.log(`taskmaster listening on ${HOST}:${PORT} (workspace: ${WORKSPACE_ROOT || '(none)'})`)
})
