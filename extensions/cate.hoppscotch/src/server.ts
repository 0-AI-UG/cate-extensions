// =============================================================================
// cate.hoppscotch wrapper server (connect-only + built-in request proxy).
//
// This extension does NOT bundle Hoppscotch (its web app is a monorepo build
// with no distributable package; the supported self-host channel is the docker
// AIO image). The user runs their own instance; this wrapper:
//
//   1. Binds Cate's PORT on 127.0.0.1 and serves /health (200) immediately.
//   2. Resolves the upstream Hoppscotch origin: stored value (cate.storage,
//      key `hoppscotch:upstream`) -> HOPPSCOTCH_UPSTREAM env -> AUTO-DETECT a
//      running instance (convention default localhost:3000, then a
//      `docker ps` / `lsof` scan for a "hoppscotch" listener) -> none.
//   3. Serves the shell page at `/` (+ control routes under /__hopp/*), and
//      reverse-proxies every other route to the upstream — rewriting the
//      root-absolute URLs in its HTML/CSS/JS against the panel's public base
//      so the SPA loads under Cate's opaque `/ext/<routeToken>/` prefix (see
//      src/rewrite.ts).
//   4. Implements the Proxyscotch wire protocol on /__hopp/proxy so the
//      embedded app's "Proxy" interceptor executes API requests through this
//      loopback process instead of the webview (no CORS / CSP limits). See
//      src/pscotch.ts for the protocol.
//
// Cate injects: PORT, HOST, CATE_TOKEN, WORKSPACE_ROOT, CATE_API. Every request
// except /health requires Authorization: Bearer ${CATE_TOKEN}; the proxy
// injects it and the page never holds it.
// =============================================================================

import http from 'http'
import https from 'https'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import {
  normalizeUpstream,
  resolveUpstream,
  normalizePublicBase,
  HOPPSCOTCH_DEFAULT_FRONTEND,
  UPSTREAM_ENV,
  UPSTREAM_STORAGE_KEY,
  CONTROL_PREFIX,
} from './config'
import {
  parseProxyRequest,
  buildTargetUrl,
  errorBody,
  greetingBody,
  successBody,
  type ProxyRequest,
} from './pscotch'
import { isRewritableContentType, rewriteFor } from './rewrite'
import { detectService } from './_kit/service-detect'

const PORT = Number(process.env.PORT)
const TOKEN = process.env.CATE_TOKEN || ''
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || ''
const CATE_API = process.env.CATE_API || ''

if (!PORT) {
  console.error('hoppscotch: PORT not set by Cate; refusing to start')
  process.exit(1)
}

const SESSION_FINGERPRINT = randomUUID()

/** Rewritable upstream bodies are buffered before rewriting; cap the buffer so
 *  a huge (or hostile) upstream response can't exhaust memory. */
const MAX_REWRITE_BYTES = 16 * 1024 * 1024
/** Cap on a /__hopp/proxy target response (matches the spirit of proxyscotch's
 *  in-memory handling; Hoppscotch renders bodies, not downloads). */
const MAX_PROXY_RESPONSE_BYTES = 64 * 1024 * 1024
const PROXY_TIMEOUT_MS = 30_000
const PROXY_MAX_REDIRECTS = 5

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
// Wrapper state: the effective upstream origin (or null -> connect card) and
// the panel-reported public base used by the URL rewriters. `explicitUpstream`
// marks a manually saved / env-set value (sticky); an auto-detected one is
// ephemeral and re-checked on each status poll.
// ---------------------------------------------------------------------------

let upstream: string | null = null
let explicitUpstream = false
let publicBase: string | null = null

/** Auto-detect a Hoppscotch the user is already running: the convention default
 *  (localhost:3000) first, then any container/process named "hoppscotch".
 *  Probe-gated, so only a reachable instance is adopted. Ephemeral — never
 *  persisted; only a manually entered URL survives a restart. */
async function autoDetectUpstream(): Promise<string | null> {
  const r = await detectService({
    candidates: [HOPPSCOTCH_DEFAULT_FRONTEND],
    probePath: '/',
    processMatch: /hoppscotch/i,
  })
  if (r.baseUrl) console.log(`hoppscotch: auto-detected ${r.baseUrl} (via ${r.via})`)
  return r.baseUrl
}

// ---------------------------------------------------------------------------
// Static shell assets + small helpers.
// ---------------------------------------------------------------------------

const STATIC: Record<string, { file: string; type: string }> = {
  [`${CONTROL_PREFIX}/app.js`]: { file: 'public/app.js', type: 'text/javascript; charset=utf-8' },
  [`${CONTROL_PREFIX}/app.css`]: { file: 'public/app.css', type: 'text/css; charset=utf-8' },
}

function readPublic(rel: string): Buffer {
  return fs.readFileSync(path.join(__dirname, rel))
}

// Shell page: our own script + external stylesheet only (no inline JS). The
// embedded app is reverse-proxied same-origin, so 'self' covers framing it.
const PAGE_CSP =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; " +
  "font-src 'self' data:; " +
  "connect-src 'self'; " +
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

function sendShell(res: http.ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': PAGE_CSP,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(readPublic('public/index.html'))
}

function readBody(req: http.IncomingMessage, cap = 4 * 1024 * 1024): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (c: Buffer) => {
      total += c.length
      if (total <= cap) chunks.push(c)
    })
    req.on('end', () => resolve(total <= cap ? Buffer.concat(chunks).toString('utf8') : ''))
    req.on('error', () => resolve(''))
  })
}

/** Probe an upstream's root with a short timeout. */
function probe(target: string): Promise<boolean> {
  return new Promise((resolve) => {
    let url: URL
    try {
      url = new URL('/', target)
    } catch {
      return resolve(false)
    }
    const lib = url.protocol === 'https:' ? https : http
    const r = lib.request(
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
// Reverse proxy of the Hoppscotch web UI (HTML/CSS/JS rewritten, rest streamed).
// ---------------------------------------------------------------------------

/** Injected first in proxied HTML: the SPA's router expects to live at '/',
 *  but the iframe document is under /ext/<routeToken>/. Assets are safe (their
 *  URLs are rewritten server-side to carry the prefix), so snapping the visible
 *  URL back to '/' before the app boots keeps vue-router on its home route. */
const HISTORY_SHIM = '<script>history.replaceState(null, "", "/");</script>'

function injectHistoryShim(html: string): string {
  const headMatch = /<head[^>]*>/i.exec(html)
  if (headMatch) {
    const at = headMatch.index + headMatch[0].length
    return html.slice(0, at) + HISTORY_SHIM + html.slice(at)
  }
  return HISTORY_SHIM + html
}

function proxyUi(req: http.IncomingMessage, res: http.ServerResponse, target: string): void {
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
  // Plain bodies only, so the text rewriters (and content-length fix-up) see
  // uncompressed bytes. Loopback/LAN upstream — compression buys nothing here.
  headers['accept-encoding'] = 'identity'

  const lib = url.protocol === 'https:' ? https : http
  const upstreamReq = lib.request(
    {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: url.pathname + url.search,
      headers,
    },
    (upstreamRes) => {
      const outHeaders = { ...upstreamRes.headers }
      // Strip framing/CSP guards so the proxied UI renders inside our iframe.
      delete outHeaders['x-frame-options']
      delete outHeaders['content-security-policy']

      const contentType = String(upstreamRes.headers['content-type'] || '')
      if (publicBase && isRewritableContentType(contentType)) {
        const chunks: Buffer[] = []
        let total = 0
        let overflow = false
        upstreamRes.on('data', (c: Buffer) => {
          total += c.length
          if (total > MAX_REWRITE_BYTES) overflow = true
          if (!overflow) chunks.push(c)
        })
        upstreamRes.on('end', () => {
          if (overflow) {
            // Too big to rewrite safely — pass through unmodified.
            delete outHeaders['content-length']
            res.writeHead(upstreamRes.statusCode || 502, outHeaders)
            res.end(Buffer.concat(chunks))
            return
          }
          let text = Buffer.concat(chunks).toString('utf8')
          text = rewriteFor(contentType)(text, publicBase!)
          if (contentType.toLowerCase().includes('text/html')) {
            text = injectHistoryShim(text)
          }
          const body = Buffer.from(text, 'utf8')
          outHeaders['content-length'] = String(body.byteLength)
          res.writeHead(upstreamRes.statusCode || 502, outHeaders)
          res.end(body)
        })
        upstreamRes.on('error', () => {
          if (!res.headersSent) res.writeHead(502)
          res.end()
        })
        return
      }

      res.writeHead(upstreamRes.statusCode || 502, outHeaders)
      upstreamRes.pipe(res)
    },
  )

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

// ---------------------------------------------------------------------------
// Proxyscotch-compatible request execution (/__hopp/proxy).
// ---------------------------------------------------------------------------

interface TargetResponse {
  status: number
  statusText: string
  headers: Record<string, string | string[] | undefined>
  body: Buffer
}

/** Execute one proxied request, following up to `redirectsLeft` redirects
 *  (proxyscotch relies on Go's redirect-following http.Client). */
function executeTarget(pr: ProxyRequest, targetUrl: string, redirectsLeft: number): Promise<TargetResponse> {
  return new Promise((resolve, reject) => {
    let url: URL
    try {
      url = new URL(targetUrl)
    } catch (err) {
      reject(err)
      return
    }
    const headers: Record<string, string> = { ...pr.headers }
    if (pr.auth) {
      headers['Authorization'] =
        'Basic ' + Buffer.from(`${pr.auth.username}:${pr.auth.password}`).toString('base64')
    }
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'user-agent')) {
      headers['User-Agent'] = 'Proxyscotch/1.1 (cate.hoppscotch)'
    }
    headers['Accept-Encoding'] = 'identity'

    const lib = url.protocol === 'https:' ? https : http
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: pr.method,
        headers,
        timeout: PROXY_TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode || 0
        const location = res.headers['location']
        if (status >= 300 && status < 400 && typeof location === 'string' && redirectsLeft > 0) {
          res.resume()
          let next: string
          try {
            next = new URL(location, url).toString()
          } catch {
            reject(new Error(`bad redirect location: ${location}`))
            return
          }
          // 303 (and 301/302 on POST, per browser/Go behavior) demote to GET.
          const demote = status === 303 || ((status === 301 || status === 302) && pr.method === 'POST')
          const nextPr: ProxyRequest = demote ? { ...pr, method: 'GET', data: '' } : pr
          executeTarget(nextPr, next, redirectsLeft - 1).then(resolve, reject)
          return
        }
        const chunks: Buffer[] = []
        let total = 0
        res.on('data', (c: Buffer) => {
          total += c.length
          if (total > MAX_PROXY_RESPONSE_BYTES) {
            req.destroy()
            reject(new Error('response too large'))
            return
          }
          chunks.push(c)
        })
        res.on('end', () => {
          resolve({
            status,
            statusText: res.statusMessage || '',
            headers: res.headers,
            body: Buffer.concat(chunks),
          })
        })
        res.on('error', reject)
      },
    )
    req.on('timeout', () => {
      req.destroy(new Error('request timed out'))
    })
    req.on('error', reject)
    if (pr.data.length > 0) req.write(pr.data)
    req.end()
  })
}

async function handleProxyEndpoint(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  // Mirror proxyscotch's permissive CORS on this endpoint: from the embedded
  // (same-origin) app it's moot, but it keeps external Hoppscotch tabs pointed
  // at this proxy URL working too.
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')

  if (req.method === 'OPTIONS') {
    res.writeHead(200)
    res.end()
    return
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')

  if (req.method !== 'POST') {
    res.writeHead(200)
    res.end(greetingBody(SESSION_FINGERPRINT))
    return
  }

  const raw = await readBody(req)
  const parsed = parseProxyRequest(raw)
  if (!parsed.ok) {
    // Protocol quirk: errors are HTTP 200 with success:false (what the
    // Hoppscotch client parses and renders).
    res.writeHead(200)
    res.end(errorBody(parsed.message))
    return
  }
  try {
    const target = buildTargetUrl(parsed.req)
    const done = await executeTarget(parsed.req, target, PROXY_MAX_REDIRECTS)
    res.writeHead(200)
    res.end(
      successBody({
        status: done.status,
        statusText: done.statusText,
        headers: done.headers,
        body: done.body,
        wantsBinary: parsed.req.wantsBinary,
      }),
    )
  } catch (err) {
    res.writeHead(200)
    res.end(errorBody(`Request failed: ${err instanceof Error ? err.message : String(err)}`))
  }
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

  // Shell page at the panel root; the embedded app lives on the proxied routes.
  if (pathname === '/' || pathname === '') {
    sendShell(res)
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

  // Status — what the panel renders. The panel reports its public base here
  // (`?base=/ext/<routeToken>/`), which the UI rewriters need.
  if (pathname === `${CONTROL_PREFIX}/status` && req.method === 'GET') {
    const base = normalizePublicBase(url.searchParams.get('base'))
    if (base) publicBase = base
    // With no manual/env upstream, re-run auto-detection so an instance started
    // after the panel opened is picked up on the next check (panel Retry).
    if (!explicitUpstream) upstream = await autoDetectUpstream()
    const reachable = upstream ? await probe(upstream) : false
    sendJson(res, 200, {
      upstream,
      reachable,
      source: explicitUpstream ? 'manual' : upstream ? 'auto' : null,
      workspaceRoot: WORKSPACE_ROOT || null,
      proxyPath: `${CONTROL_PREFIX}/proxy`,
    })
    return
  }

  // Configure / clear the upstream instance URL (persisted via cate.storage).
  if (pathname === `${CONTROL_PREFIX}/upstream` && req.method === 'POST') {
    const raw = await readBody(req)
    let body: { upstream?: unknown } = {}
    try {
      body = JSON.parse(raw || '{}')
    } catch {
      /* body stays {} */
    }
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

  // The built-in Proxyscotch-compatible request proxy.
  if (pathname === `${CONTROL_PREFIX}/proxy`) {
    await handleProxyEndpoint(req, res)
    return
  }

  // Everything else is the embedded app — reverse-proxy to the upstream.
  if (upstream == null) {
    sendJson(res, 503, { error: 'no upstream configured' })
    return
  }
  proxyUi(req, res, upstream)
})

// Proxy WebSocket upgrades to the configured upstream (realtime tabs, backend
// subscriptions).
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
  const lib = target.protocol === 'https:' ? https : http
  const upstreamReq = lib.request({
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
  console.log(
    `hoppscotch wrapper listening on 127.0.0.1:${PORT} (workspace: ${WORKSPACE_ROOT || '(none)'})`,
  )
  void (async () => {
    const stored = await storedUpstream()
    upstream = resolveUpstream({ stored, env: process.env[UPSTREAM_ENV] })
    explicitUpstream = upstream != null
    if (!explicitUpstream) upstream = await autoDetectUpstream()
    if (upstream) {
      console.log(`hoppscotch: proxying to ${upstream}${explicitUpstream ? '' : ' (auto-detected)'}`)
    } else {
      console.log('hoppscotch: no upstream found; serving connect card')
    }
  })()
})
