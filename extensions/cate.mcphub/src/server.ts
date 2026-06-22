// =============================================================================
// cate.mcphub wrapper server.
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
//   - GET /__mcphub/* — wrapper-owned shell page + assets (themed loader, status
//     and error UI) served before/around the embedded dashboard.
//   - Everything else — reverse-proxied to the internal MCPHub child, which the
//     wrapper spawns lazily on first non-shell request and supervises.
//
// MCPHub runs on a private internal port (it binds 0.0.0.0 and ignores HOST, so
// we never give it Cate's PORT; we proxy over 127.0.0.1). See src/mcphub.ts.
// =============================================================================

import http from 'http'
import fs from 'fs'
import path from 'path'
import { Socket } from 'net'
import { spawnMcphub, McphubProcess, MCPHUB_BASE_PATH } from './mcphub'
import { waitForReady, forwardHttp, forwardUpgrade, findFreePort } from './proxy'

const PORT = Number(process.env.PORT)
const TOKEN = process.env.CATE_TOKEN || ''
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || '(none)'

if (!PORT) {
  console.error('cate.mcphub: PORT not set by Cate; refusing to start')
  process.exit(1)
}

// --- MCPHub child supervision -----------------------------------------------

interface HubState {
  status: 'idle' | 'starting' | 'ready' | 'error'
  proc: McphubProcess | null
  internalPort: number | null
  via: string | null
  error: string | null
  stderrTail: string[]
}

const hub: HubState = {
  status: 'idle',
  proc: null,
  internalPort: null,
  via: null,
  error: null,
  stderrTail: [],
}

let starting: Promise<void> | null = null

function recordStderr(line: string): void {
  for (const part of line.split(/\r?\n/)) {
    const trimmed = part.trimEnd()
    if (!trimmed) continue
    hub.stderrTail.push(trimmed)
    if (hub.stderrTail.length > 50) hub.stderrTail.shift()
  }
}

/** Start MCPHub once; concurrent callers await the same promise. */
function ensureHub(): Promise<void> {
  if (hub.status === 'ready') return Promise.resolve()
  if (starting) return starting

  starting = (async () => {
    hub.status = 'starting'
    hub.error = null
    try {
      const internalPort = await findFreePort()
      const proc = spawnMcphub(internalPort)
      hub.proc = proc
      hub.internalPort = internalPort
      hub.via = proc.spec.via

      // Resolves early (false) if the child dies during startup, so we don't
      // wait out the full readiness timeout on an immediate spawn failure.
      let died: (() => void) | null = null
      const earlyExit = new Promise<false>((resolve) => {
        died = () => resolve(false)
      })

      proc.child.stderr?.on('data', (b: Buffer) => recordStderr(b.toString('utf8')))
      proc.child.stdout?.on('data', (b: Buffer) => recordStderr(b.toString('utf8')))
      proc.child.on('exit', (code, signal) => {
        if (hub.status !== 'error') {
          hub.status = 'error'
          hub.error = `MCPHub exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`
        }
        hub.proc = null
        starting = null
        died?.()
      })
      proc.child.on('error', (err) => {
        hub.status = 'error'
        hub.error = `Failed to launch MCPHub: ${err.message}`
        starting = null
        died?.()
      })

      const ready = await Promise.race([
        waitForReady(internalPort, { timeoutMs: 45000 }),
        earlyExit,
      ])
      if (!ready) {
        // A child exit/error handler may have already set a precise message; only
        // fall back to the generic timeout text if nothing did. (Checking
        // hub.error rather than hub.status sidesteps TS's stale narrowing of the
        // status literal set at the top of start().)
        hub.status = 'error'
        if (!hub.error) hub.error = 'MCPHub did not become ready within 45s'
        return
      }
      hub.status = 'ready'
    } catch (err) {
      hub.status = 'error'
      hub.error = err instanceof Error ? err.message : String(err)
    } finally {
      // Clear the in-flight latch unless we're still mid-start, so a later retry
      // can re-run. `hub.status` is mutated across awaits/handlers; compare via a
      // widened local so TS doesn't narrow against the 'starting' set above.
      const settled = hub.status as string
      if (settled !== 'starting') starting = null
    }
  })()

  return starting
}

function stopHub(): void {
  const child = hub.proc?.child
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

process.on('SIGTERM', () => {
  stopHub()
  process.exit(0)
})
process.on('SIGINT', () => {
  stopHub()
  process.exit(0)
})

// --- auth + static shell -----------------------------------------------------

function authorized(req: http.IncomingMessage): boolean {
  const header = String(req.headers['authorization'] || '')
  return TOKEN.length > 0 && header === `Bearer ${TOKEN}`
}

// The shell page bootstraps theming/status via window.cate, then embeds the
// dashboard in an iframe pointed at the proxied MCPHub root. External script
// only; same-origin frame allowed.
const SHELL_CSP =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "font-src 'self' data:; " +
  "connect-src 'self' ws: wss:; " +
  "frame-src 'self'; " +
  'frame-ancestors *'

interface StaticAsset {
  file: string
  type: string
}

const SHELL_STATIC: Record<string, StaticAsset> = {
  '/__mcphub/app.js': { file: 'public/app.js', type: 'text/javascript; charset=utf-8' },
  '/__mcphub/style.css': { file: 'public/style.css', type: 'text/css; charset=utf-8' },
}

function readPublic(rel: string): Buffer {
  return fs.readFileSync(path.join(__dirname, rel))
}

function sendShell(res: http.ServerResponse): void {
  const html = readPublic('public/shell.html')
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

// --- HTTP server -------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const pathname = url.pathname

  // Readiness probe, auth-exempt so Cate's probe (no token yet) succeeds. This
  // reports the WRAPPER's readiness, not MCPHub's — the wrapper is up as soon as
  // it is listening; MCPHub starts lazily on the first dashboard request.
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
  if (pathname === '/' || pathname === '' || pathname === '/__mcphub/' ) {
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
  if (pathname === '/__mcphub/status' && req.method === 'GET') {
    sendJson(res, 200, {
      status: hub.status,
      via: hub.via,
      error: hub.error,
      workspaceRoot: WORKSPACE_ROOT,
      stderrTail: hub.stderrTail.slice(-12),
    })
    return
  }

  // Kick off (or retry) MCPHub start, then tell the shell to embed it.
  if (pathname === '/__mcphub/start' && req.method === 'POST') {
    try {
      await ensureHub()
    } catch (err) {
      hub.status = 'error'
      hub.error = err instanceof Error ? err.message : String(err)
    }
    sendJson(res, 200, { status: hub.status, error: hub.error })
    return
  }

  // Anything under MCPHub's mounted base path is the dashboard: ensure MCPHub
  // is up, then proxy. MCPHub serves itself and all its absolute-path assets/API
  // under this prefix (BASE_PATH), so no URL rewriting is needed.
  if (pathname === MCPHUB_BASE_PATH || pathname.startsWith(MCPHUB_BASE_PATH + '/')) {
    await ensureHub()
    if (hub.status !== 'ready' || hub.internalPort == null) {
      sendJson(res, 503, {
        error: hub.error || 'MCPHub not ready',
        status: hub.status,
        stderrTail: hub.stderrTail.slice(-12),
      })
      return
    }
    forwardHttp(hub.internalPort, req, res)
    return
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('Not found')
})

// WebSocket / SSE-upgrade tunnel to MCPHub. The proxy injects the bearer on the
// upgrade too, so check it here, then forward to the internal port.
server.on('upgrade', (req, socket: Socket, head: Buffer) => {
  if (!authorized(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.destroy()
    return
  }
  const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname
  if (!(pathname === MCPHUB_BASE_PATH || pathname.startsWith(MCPHUB_BASE_PATH + '/'))) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
    socket.destroy()
    return
  }
  if (hub.status !== 'ready' || hub.internalPort == null) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n')
    socket.destroy()
    return
  }
  forwardUpgrade(hub.internalPort, req, socket, head)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`cate.mcphub wrapper listening on 127.0.0.1:${PORT} (workspace: ${WORKSPACE_ROOT})`)
})
