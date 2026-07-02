// =============================================================================
// cate.datasette wrapper server.
//
// Cate spawns this and injects env:
//   PORT           free loopback port to bind on 127.0.0.1 (Cate's contract)
//   HOST           127.0.0.1 (we bind exactly this)
//   CATE_TOKEN     bearer the proxy injects on every request to us
//   WORKSPACE_ROOT workspace root path on the runtime host
//   CATE_API       loopback URL that tunnels back into Cate's reverse API
//
// What it does:
//   - Binds PORT on 127.0.0.1.
//   - GET /health (auth-exempt) — Cate's readiness probe.
//   - GET / + /__datasette/* — wrapper-owned shell page, assets, and the
//     status/start/restart control endpoints driving the provisioning UI.
//   - /db/* — reverse-proxied to the internal Datasette child, which the
//     wrapper spawns lazily on the panel's first start request and supervises.
//
// Cate serves the panel under an opaque `/ext/<routeToken>/` prefix and strips
// it before forwarding to us. Datasette needs to emit URLs that carry that
// prefix, so the panel reports its own public base (`location.pathname`) with
// the start request and the child is launched with
// `--setting base_url <publicBase>db/`. The wrapper then re-adds the prefix
// when forwarding /db/* (the child serves under the FULL base_url path).
// =============================================================================

import http from 'http'
import fs from 'fs'
import path from 'path'
import { ChildProcess } from 'child_process'
import {
  spawnDatasette,
  resolveLaunch,
  normalizePublicBase,
  baseUrlFor,
  DatasetteProcess,
} from './datasette'
import { findSqliteFiles } from './scan'
import { waitForReady, forwardHttp, findFreePort } from './proxy'

const PORT = Number(process.env.PORT)
const TOKEN = process.env.CATE_TOKEN || ''
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || ''

if (!PORT) {
  console.error('cate.datasette: PORT not set by Cate; refusing to start')
  process.exit(1)
}

// --- Datasette child supervision ----------------------------------------------

interface ChildState {
  status: 'idle' | 'starting' | 'ready' | 'error'
  proc: DatasetteProcess | null
  internalPort: number | null
  publicBase: string | null
  dbFiles: string[]
  via: string | null
  error: string | null
  stderrTail: string[]
}

const ds: ChildState = {
  status: 'idle',
  proc: null,
  internalPort: null,
  publicBase: null,
  dbFiles: [],
  via: null,
  error: null,
  stderrTail: [],
}

let starting: Promise<void> | null = null

/** Monotonic run id. Each (re)start bumps it; stopChild() bumps it too. Event
 *  handlers and post-await steps capture their run's id and no-op when a newer
 *  run owns the state, so a replaced child's late exit/output can never clobber
 *  the run that superseded it (the retry/rescan race). */
let generation = 0

function recordStderr(line: string): void {
  for (const part of line.split(/\r?\n/)) {
    const trimmed = part.trimEnd()
    if (!trimmed) continue
    ds.stderrTail.push(trimmed)
    if (ds.stderrTail.length > 50) ds.stderrTail.shift()
  }
}

/** Start Datasette once for `publicBase`; concurrent callers await the same
 *  promise. A ready child started for a DIFFERENT base is restarted (its
 *  base_url is baked into the command line). */
function ensureChild(publicBase: string): Promise<void> {
  if (ds.status === 'ready' && ds.publicBase === publicBase) return Promise.resolve()
  if (starting) return starting
  if (ds.status === 'ready') stopChild() // base changed — relaunch below

  const gen = ++generation
  starting = (async () => {
    ds.status = 'starting'
    ds.error = null
    ds.publicBase = publicBase
    ds.stderrTail = [] // this run's log, not the previous failure's
    try {
      // Re-scan on every (re)start so a restart picks up newly created files.
      ds.dbFiles = WORKSPACE_ROOT ? findSqliteFiles(WORKSPACE_ROOT) : []
      const internalPort = await findFreePort()
      if (gen !== generation) return // stopped/superseded while acquiring the port
      const proc = spawnDatasette(ds.dbFiles, internalPort, publicBase)
      ds.proc = proc
      ds.internalPort = internalPort
      ds.via = proc.spec.via

      // Resolves early (false) if the child dies during startup, so we don't
      // wait out the full readiness timeout on an immediate spawn failure.
      let died: (() => void) | null = null
      const earlyExit = new Promise<false>((resolve) => {
        died = () => resolve(false)
      })

      proc.child.stderr?.on('data', (b: Buffer) => {
        if (gen === generation) recordStderr(b.toString('utf8'))
      })
      proc.child.stdout?.on('data', (b: Buffer) => {
        if (gen === generation) recordStderr(b.toString('utf8'))
      })
      proc.child.on('exit', (code, signal) => {
        died?.()
        if (gen !== generation) return // a replaced child exiting is expected
        if (ds.status !== 'error') {
          ds.status = 'error'
          ds.error = `Datasette exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`
        }
        ds.proc = null
      })
      proc.child.on('error', (err) => {
        died?.()
        if (gen !== generation) return
        ds.status = 'error'
        ds.error =
          `Failed to launch Datasette via ${proc.spec.via} (${proc.spec.command}): ${err.message}` +
          (proc.spec.via === 'env' ? ' — check DATASETTE_CMD.' : '')
      })

      // Generous window: a first `uvx datasette` / `pipx run datasette` also
      // downloads the package (and possibly a Python) into its cache.
      const ready = await Promise.race([
        waitForReady(internalPort, { timeoutMs: 90000, path: baseUrlFor(publicBase) }),
        earlyExit,
      ])
      if (gen !== generation) return // superseded mid-wait; the new run owns ds
      if (!ready) {
        // A child exit/error handler may have already set a precise message; only
        // fall back to the generic timeout text if nothing did. (Checking
        // ds.error rather than ds.status sidesteps TS's stale narrowing of the
        // status literal set at the top of start().) Setting status BEFORE the
        // kill keeps the SIGTERM-induced exit handler from rewriting the message.
        ds.status = 'error'
        if (!ds.error) ds.error = 'Datasette did not become ready within 90s'
        killChild(ds.proc?.child) // readiness timeout: reap the stuck child so a retry can't stack a second one
        ds.proc = null
        ds.internalPort = null
        return
      }
      ds.status = 'ready'
    } catch (err) {
      ds.status = 'error'
      ds.error = err instanceof Error ? err.message : String(err)
    } finally {
      // Clear the in-flight latch unless a newer run owns it by now.
      if (gen === generation) starting = null
    }
  })()

  return starting
}

/** SIGTERM the child, escalating to SIGKILL after 3s if it lingers. */
function killChild(child: ChildProcess | null | undefined): void {
  if (!child) return
  try {
    child.kill('SIGTERM')
    setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }, 3000).unref()
  } catch {
    /* already gone */
  }
}

function stopChild(): void {
  generation++ // orphan any in-flight start and the old child's events
  starting = null
  const child = ds.proc?.child
  ds.status = 'idle'
  ds.proc = null
  ds.internalPort = null
  killChild(child)
}

process.on('SIGTERM', () => {
  stopChild()
  process.exit(0)
})
process.on('SIGINT', () => {
  stopChild()
  process.exit(0)
})
// Last-resort reap for exits that don't go through the signal handlers (crash,
// natural exit). 'exit' runs synchronously and timers never fire after it, so
// SIGKILL directly rather than the graceful TERM→KILL escalation.
process.on('exit', () => {
  try {
    ds.proc?.child.kill('SIGKILL')
  } catch {
    /* already gone */
  }
})

// --- auth + static shell -------------------------------------------------------

function authorized(req: http.IncomingMessage): boolean {
  const header = String(req.headers['authorization'] || '')
  return TOKEN.length > 0 && header === `Bearer ${TOKEN}`
}

// The shell page bootstraps theming/status via window.cate, then embeds
// Datasette in an iframe pointed at the proxied /db/ mount. External script
// only; same-origin frame allowed.
const SHELL_CSP =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "font-src 'self' data:; " +
  "connect-src 'self'; " +
  "frame-src 'self'; " +
  'frame-ancestors *'

interface StaticAsset {
  file: string
  type: string
}

const SHELL_STATIC: Record<string, StaticAsset> = {
  '/__datasette/app.js': { file: 'public/app.js', type: 'text/javascript; charset=utf-8' },
  '/__datasette/app.css': { file: 'public/app.css', type: 'text/css; charset=utf-8' },
}

function readPublic(rel: string): Buffer {
  return fs.readFileSync(path.join(__dirname, rel))
}

function sendShell(res: http.ServerResponse): void {
  const html = readPublic('public/index.html')
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': SHELL_CSP,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(html)
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

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
  })
}

/** The panel-facing status payload (also the response of start/restart). */
function statusPayload(): Record<string, unknown> {
  return {
    status: ds.status,
    via: ds.via,
    error: ds.error,
    workspaceRoot: WORKSPACE_ROOT || null,
    dbCount: ds.dbFiles.length,
    dbNames: ds.dbFiles.map((f) => path.basename(f)),
    stderrTail: ds.stderrTail.slice(-12),
  }
}

/** Parse + validate the publicBase in a start/restart request body. */
async function publicBaseFrom(req: http.IncomingMessage): Promise<string | null> {
  const raw = await readBody(req)
  try {
    const body = JSON.parse(raw || '{}') as { publicBase?: unknown }
    return normalizePublicBase(body.publicBase)
  } catch {
    return null
  }
}

// --- HTTP server ---------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const pathname = url.pathname

  // Readiness probe, auth-exempt so Cate's probe (no token yet) succeeds. This
  // reports the WRAPPER's readiness, not Datasette's — the wrapper is up as soon
  // as it is listening; Datasette starts lazily on the panel's start request.
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('ok')
    return
  }

  if (!authorized(req)) {
    res.writeHead(401, { 'Content-Type': 'text/plain' })
    res.end('Unauthorized: missing or wrong Bearer token')
    return
  }

  // Wrapper shell page is served at the panel root.
  if (pathname === '/' || pathname === '') {
    sendShell(res)
    return
  }

  // Wrapper-owned static assets.
  const asset = SHELL_STATIC[pathname]
  if (asset) {
    try {
      const data = readPublic(asset.file)
      res.writeHead(200, {
        'Content-Type': asset.type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      })
      res.end(data)
    } catch {
      res.writeHead(404).end('Not found')
    }
    return
  }

  // Wrapper status (for the shell loader/error UI).
  if (pathname === '/__datasette/status' && req.method === 'GET') {
    sendJson(res, 200, statusPayload())
    return
  }

  // Kick off (or retry) the Datasette start, then tell the shell to embed it.
  if (pathname === '/__datasette/start' && req.method === 'POST') {
    const publicBase = await publicBaseFrom(req)
    if (!publicBase) {
      sendJson(res, 400, { error: 'bad-public-base' })
      return
    }
    try {
      await ensureChild(publicBase)
    } catch (err) {
      ds.status = 'error'
      ds.error = err instanceof Error ? err.message : String(err)
    }
    sendJson(res, 200, statusPayload())
    return
  }

  // Stop + relaunch (fresh workspace scan) — the panel's "Rescan" action.
  if (pathname === '/__datasette/restart' && req.method === 'POST') {
    const publicBase = await publicBaseFrom(req)
    if (!publicBase) {
      sendJson(res, 400, { error: 'bad-public-base' })
      return
    }
    stopChild()
    try {
      await ensureChild(publicBase)
    } catch (err) {
      ds.status = 'error'
      ds.error = err instanceof Error ? err.message : String(err)
    }
    sendJson(res, 200, statusPayload())
    return
  }

  // Anything under the /db mount is Datasette itself. The child serves under
  // its FULL base_url (<publicBase>db/), so re-add the public prefix Cate's
  // proxy stripped before forwarding.
  if (pathname === '/db' || pathname.startsWith('/db/')) {
    if (ds.status !== 'ready' || ds.internalPort == null || ds.publicBase == null) {
      sendJson(res, 503, {
        error: ds.error || 'Datasette not ready',
        status: ds.status,
        stderrTail: ds.stderrTail.slice(-12),
      })
      return
    }
    const upstreamPath = ds.publicBase.slice(0, -1) + (req.url || pathname)
    forwardHttp(ds.internalPort, upstreamPath, req, res)
    return
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('Not found')
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(
    `cate.datasette wrapper listening on 127.0.0.1:${PORT} (workspace: ${WORKSPACE_ROOT || '(none)'}, launch: ${
      resolveLaunch()?.via ?? 'none found'
    })`,
  )
})
