// =============================================================================
// DeepWiki launcher (server-backed Cate extension) — CONNECT-ONLY.
//
// This extension does NOT bundle or provision DeepWiki. The user runs their own
// DeepWiki-Open instance (e.g. `docker compose up`); this Node server reverse-
// proxies the Cate panel to it and adds Cate-native glue (code-reference links,
// theming, provider-key reuse surfaced as a ready-to-paste .env).
//
//   1. On spawn we bind PORT on 127.0.0.1 and serve /health (200) immediately,
//      satisfying Cate's readiness probe.
//   2. We resolve the upstream DeepWiki origin: stored value (cate.storage, key
//      `deepwiki:upstream`) -> DEEPWIKI_UPSTREAM env -> AUTO-DETECT a running
//      instance (convention default localhost:3000, then a `docker ps` / `lsof`
//      scan for a "deepwiki" listener) -> none. Only a stored/env value is
//      sticky; an auto-detected one is ephemeral and re-checked each status poll.
//   3. With an upstream resolved we reverse-proxy every non-control route (HTTP
//      and WebSocket upgrades) to it, stripping X-Frame-Options / upstream CSP so
//      it frames in the sandboxed webview.
//   4. With no upstream found we serve a config page that prompts for the
//      running DeepWiki URL and shows the .env derived from Cate's provider keys.
//
// Cate injects: PORT, HOST, CATE_TOKEN, WORKSPACE_ROOT, CATE_API. Every request
// except /health requires Authorization: Bearer ${CATE_TOKEN}; the proxy injects
// it and the page never holds it.
// =============================================================================

import http from 'http'
import fs from 'fs'
import path from 'path'
import {
  deriveProviderEnv,
  connectedProviders,
  hasReusableProvider,
  type AuthJson,
  type ModelsJson,
} from './auth'
import {
  resolveUpstream,
  normalizeUpstream,
  DEEPWIKI_DEFAULT_FRONTEND,
  UPSTREAM_ENV,
  UPSTREAM_STORAGE_KEY,
} from './config'
import { detectService } from './_kit/service-detect'

const PORT = Number(process.env.PORT)
const TOKEN = process.env.CATE_TOKEN || ''
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || ''
const CATE_API = process.env.CATE_API || ''

if (!PORT) {
  console.error('deepwiki: PORT not set by Cate; refusing to start')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Cate provider reuse: read <WORKSPACE_ROOT>/.cate/pi-agent/{auth,models}.json
// ---------------------------------------------------------------------------

function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as T
  } catch {
    return null
  }
}

function piAgentDir(): string {
  return path.join(WORKSPACE_ROOT || '.', '.cate', 'pi-agent')
}

function readCateAuth(): { auth: AuthJson | null; models: ModelsJson | null } {
  const dir = piAgentDir()
  return {
    auth: readJson<AuthJson>(path.join(dir, 'auth.json')),
    models: readJson<ModelsJson>(path.join(dir, 'models.json')),
  }
}

// ---------------------------------------------------------------------------
// CATE_API reverse channel (storage get/set/delete lives here).
// ---------------------------------------------------------------------------

function callCateApi(method: string, args?: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!CATE_API) return reject(new Error('CATE_API not set'))
    const body = JSON.stringify({ method, args: args || {} })
    const u = new URL(CATE_API)
    const r = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname || '/',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${TOKEN}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${text}`))
          try {
            resolve(JSON.parse(text))
          } catch {
            resolve(text)
          }
        })
      },
    )
    r.on('error', reject)
    r.end(body)
  })
}

function unwrap(v: unknown): unknown {
  return v && typeof v === 'object' && 'result' in v ? (v as { result: unknown }).result : v
}

async function storedUpstream(): Promise<string | undefined> {
  if (!CATE_API) return undefined
  try {
    const v = unwrap(await callCateApi('cate.storage.get', { key: UPSTREAM_STORAGE_KEY }))
    return typeof v === 'string' ? v : undefined
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Launcher state: the effective upstream DeepWiki origin (or null -> config
// page). `explicitUpstream` marks it as a manually saved / env-set value, which
// is sticky and persisted; otherwise `upstream` is an auto-detected instance,
// re-resolved on each status check and never written to storage.
// ---------------------------------------------------------------------------

let upstream: string | null = null
let explicitUpstream = false

/** Auto-detect a DeepWiki the user is already running: the convention default
 *  (localhost:3000) first, then any container/process named "deepwiki". Probe-
 *  gated, so only a reachable instance is adopted. Ephemeral — never persisted;
 *  only a manually entered URL survives a restart. */
async function autoDetectUpstream(): Promise<string | null> {
  const r = await detectService({
    candidates: [DEEPWIKI_DEFAULT_FRONTEND],
    probePath: '/',
    processMatch: /deepwiki/i,
  })
  if (r.baseUrl) console.log(`deepwiki: auto-detected ${r.baseUrl} (via ${r.via})`)
  return r.baseUrl
}

// ---------------------------------------------------------------------------
// Static control-panel assets (served from this file's own dir).
// ---------------------------------------------------------------------------

const STATIC: Record<string, { file: string; type: string }> = {
  '/app.js': { file: 'public/app.js', type: 'text/javascript; charset=utf-8' },
  '/app.css': { file: 'public/app.css', type: 'text/css; charset=utf-8' },
}

function readPublic(rel: string): Buffer {
  return fs.readFileSync(path.join(__dirname, rel))
}

// Our own script + external stylesheet only (no inline JS). The embedded wiki
// is reverse-proxied same-origin, so 'self' covers framing it.
const PAGE_CSP =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; " +
  "font-src 'self' data:; " +
  "connect-src 'self' ws: wss:; " +
  "frame-src 'self'; " +
  'frame-ancestors *'

function authorized(req: http.IncomingMessage): boolean {
  const header = String(req.headers['authorization'] || '')
  return TOKEN.length > 0 && header === `Bearer ${TOKEN}`
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

// ---------------------------------------------------------------------------
// Reverse proxy to the configured upstream DeepWiki instance.
// ---------------------------------------------------------------------------

function proxy(req: http.IncomingMessage, res: http.ServerResponse, target: string): void {
  let url: URL
  try {
    url = new URL(req.url || '/', target)
  } catch {
    sendJson(res, 502, { error: 'bad upstream', upstream: target })
    return
  }

  const headers = { ...req.headers }
  delete headers['authorization']
  headers['host'] = url.host

  const opts: http.RequestOptions = {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    method: req.method,
    path: url.pathname + url.search,
    headers,
  }

  const upstreamReq = http.request(opts, (upstreamRes) => {
    const outHeaders = { ...upstreamRes.headers }
    delete outHeaders['x-frame-options']
    delete outHeaders['content-security-policy']
    res.writeHead(upstreamRes.statusCode || 502, outHeaders)
    upstreamRes.pipe(res)
  })

  upstreamReq.on('error', (err) => {
    if (!res.headersSent) {
      sendJson(res, 502, {
        error: 'upstream unreachable',
        upstream: target,
        detail: err instanceof Error ? err.message : String(err),
      })
    } else {
      res.end()
    }
  })

  req.pipe(upstreamReq)
}

/** Probe an upstream's root (or a path) with a short timeout. */
function probe(target: string, pathName = '/'): Promise<boolean> {
  return new Promise((resolve) => {
    let url: URL
    try {
      url = new URL(pathName, target)
    } catch {
      return resolve(false)
    }
    const r = http.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method: 'GET',
        timeout: 1500,
      },
      (res) => {
        res.resume()
        resolve((res.statusCode || 0) > 0 && (res.statusCode || 0) < 500)
      },
    )
    r.on('error', () => resolve(false))
    r.on('timeout', () => {
      r.destroy()
      resolve(false)
    })
    r.end()
  })
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const pathname = url.pathname

  // Readiness probe (auth-exempt) — answered the instant we're listening.
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

  // Status — what the panel renders: configured upstream, reachability, and
  // which Cate providers are reusable.
  if (pathname === '/api/status' && req.method === 'GET') {
    const { auth, models } = readCateAuth()
    // With no manual/env upstream, re-run auto-detection so a DeepWiki started
    // after the panel opened is picked up on the next check (panel Retry).
    if (!explicitUpstream) upstream = await autoDetectUpstream()
    const reachable = upstream ? await probe(upstream) : false
    sendJson(res, 200, {
      upstream,
      reachable,
      source: explicitUpstream ? 'manual' : upstream ? 'auto' : null,
      workspaceRoot: WORKSPACE_ROOT || null,
      cateProviders: connectedProviders(auth),
      canReuseCateProvider: hasReusableProvider(auth, models),
    })
    return
  }

  // The ready-to-paste .env derived from Cate's provider, for the user to paste
  // into their own DeepWiki instance. Keys echoed only to the local, token-gated
  // panel; nothing is written.
  if (pathname === '/api/env' && req.method === 'GET') {
    const { auth, models } = readCateAuth()
    const env = deriveProviderEnv(auth, models)
    const lines = Object.entries(env).map(([k, v]) => `${k}=${v}`)
    sendJson(res, 200, { env, dotenv: lines.join('\n') })
    return
  }

  // Configure / clear the upstream DeepWiki instance URL (persisted via cate.storage).
  if (pathname === '/api/upstream' && req.method === 'POST') {
    const raw = await new Promise<string>((resolve) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', () => resolve(''))
    })
    let body: { upstream?: unknown } = {}
    try {
      body = JSON.parse(raw || '{}')
    } catch { /* body stays {} */ }
    const value = body.upstream === null ? null : normalizeUpstream(body.upstream)
    if (body.upstream != null && body.upstream !== '' && !value) {
      sendJson(res, 400, { ok: false, error: 'invalid upstream URL' })
      return
    }
    try {
      if (value) {
        await callCateApi('cate.storage.set', { key: UPSTREAM_STORAGE_KEY, value })
        upstream = value
        explicitUpstream = true
      } else {
        // Manual disconnect clears the saved URL and resumes auto-detection.
        await callCateApi('cate.storage.delete', { key: UPSTREAM_STORAGE_KEY })
        explicitUpstream = false
        upstream = await autoDetectUpstream()
      }
      sendJson(res, 200, { ok: true, upstream })
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
    }
    return
  }

  // Control-panel home + assets, served whenever no upstream is configured. Once
  // configured, "/" is reverse-proxied to the wiki itself.
  if (upstream == null) {
    if (pathname === '/' || pathname === '') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': PAGE_CSP,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      })
      res.end(readPublic('public/index.html'))
      return
    }
    const asset = STATIC[pathname]
    if (asset) {
      try {
        res.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-store' })
        res.end(readPublic(asset.file))
      } catch {
        res.writeHead(404).end('Not found')
      }
      return
    }
    // Any other route while unconfigured -> the config page.
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': PAGE_CSP,
      'Cache-Control': 'no-store',
    })
    res.end(readPublic('public/index.html'))
    return
  }

  // Configured: control routes are still served from our own assets so the panel
  // chrome keeps working; the embedded iframe loads the proxied wiki.
  if (STATIC[pathname]) {
    const asset = STATIC[pathname]
    try {
      res.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-store' })
      res.end(readPublic(asset.file))
    } catch {
      res.writeHead(404).end('Not found')
    }
    return
  }

  // Everything else -> reverse-proxy to the configured wiki.
  proxy(req, res, upstream)
})

// Proxy WebSocket upgrades to the configured upstream (DeepWiki streams over WS).
server.on('upgrade', (req, socket) => {
  if (!authorized(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.destroy()
    return
  }
  if (!upstream) {
    socket.destroy()
    return
  }
  let target: URL
  try {
    target = new URL(req.url || '/', upstream)
  } catch {
    socket.destroy()
    return
  }
  const headers = { ...req.headers }
  delete headers['authorization']
  headers['host'] = target.host
  const upstreamReq = http.request({
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    path: target.pathname + target.search,
    method: 'GET',
    headers,
  })
  upstreamReq.on('upgrade', (upstreamRes, upstreamSocket) => {
    const head =
      `HTTP/1.1 101 Switching Protocols\r\n` +
      Object.entries(upstreamRes.headers)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
        .join('\r\n') +
      '\r\n\r\n'
    socket.write(head)
    upstreamSocket.pipe(socket)
    socket.pipe(upstreamSocket)
    upstreamSocket.on('error', () => socket.destroy())
    socket.on('error', () => upstreamSocket.destroy())
  })
  upstreamReq.on('error', () => socket.destroy())
  upstreamReq.end()
})

// ---------------------------------------------------------------------------
// Boot: bind FAST, then resolve any configured upstream.
// ---------------------------------------------------------------------------

server.listen(PORT, '127.0.0.1', () => {
  console.log(`deepwiki launcher listening on 127.0.0.1:${PORT} (workspace: ${WORKSPACE_ROOT || '(none)'})`)
  void (async () => {
    const stored = await storedUpstream()
    upstream = resolveUpstream({ stored, env: process.env[UPSTREAM_ENV] })
    explicitUpstream = upstream != null
    if (!explicitUpstream) upstream = await autoDetectUpstream()
    if (upstream) {
      console.log(`deepwiki: proxying to ${upstream}${explicitUpstream ? '' : ' (auto-detected)'}`)
    } else {
      console.log('deepwiki: no upstream found; serving config page')
    }
  })()
})
