// =============================================================================
// Sourcebot extension server. Dependency-free at runtime (Node http only).
//
// It does NOT bundle Sourcebot (FSL license — see STATUS.md). It is a thin
// reverse proxy + native-search backend in front of a Sourcebot instance the
// USER runs. The instance is resolved as: manually saved (base URL + optional
// API key in cate.storage) -> SOURCEBOT_URL / SOURCEBOT_API_KEY env -> auto-
// detected (convention default localhost:3000, then a docker/lsof scan for a
// "sourcebot" listener). Only the manually saved value persists; the panel
// connects on its own when an instance is found and shows the manual form only
// as a fallback.
//
// Cate spawns it and injects env:
//   PORT           free loopback port to bind on 127.0.0.1
//   CATE_TOKEN     bearer Cate's proxy injects on every request to us
//   WORKSPACE_ROOT workspace root on the runtime host
//   CATE_API       loopback URL tunnelling back into Cate's reverse API
//
// Routes (all but /health require Authorization: Bearer <CATE_TOKEN>):
//   GET  /health              readiness probe (auth-exempt)
//   GET  /                    panel HTML
//   GET  /app.js, /app.css    static panel assets
//   GET  /api/config          { configured, baseUrl, reachable, hasKey }
//   POST /sbapi/search        native search -> normalized { hits, totalMatches }
//   ANY  /sb/<rest>           raw reverse-proxy to the user's Sourcebot (iframe)
//
// The Sourcebot API key (if set) is injected here, server-side; the sandboxed
// webview never holds it.
// =============================================================================

import http from 'http'
import fs from 'fs'
import path from 'path'
import { normalizeSearchResponse, normalizeBaseUrl, clampMatches } from './sourcebot'
import { requestUpstream, probe, rewriteLocation, type SourcebotConfig } from './sourcebotClient'
import { detectService } from './_kit/service-detect'

const PORT = Number(process.env.PORT)
const TOKEN = process.env.CATE_TOKEN || ''
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || '(none)'
const CATE_API = process.env.CATE_API || ''

// Storage keys the panel writes (cate.storage) and we read back via CATE_API.
const KEY_BASE_URL = 'sourcebot:baseUrl'
const KEY_API_KEY = 'sourcebot:apiKey'

// Env overrides + the convention default used for zero-config auto-detection.
const ENV_URL = 'SOURCEBOT_URL'
const ENV_KEY = 'SOURCEBOT_API_KEY'
const DEFAULT_URL = 'http://localhost:3000'

if (!PORT) {
  console.error('sourcebot: PORT not set by Cate; refusing to start')
  process.exit(1)
}

function authorized(req: http.IncomingMessage): boolean {
  const header = String(req.headers['authorization'] || '')
  return TOKEN.length > 0 && header === `Bearer ${TOKEN}`
}

// --- CATE_API round-trip (read the user's stored Sourcebot config) -----------

function callCateApi(method: string, args?: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!CATE_API) {
      reject(new Error('CATE_API not set'))
      return
    }
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

/** cate.* over the reverse endpoint may wrap the value as { result }. */
function unwrap(v: unknown): unknown {
  return v && typeof v === 'object' && 'result' in v ? (v as { result: unknown }).result : v
}

/** The user's manually saved Sourcebot config (cate.storage). Null if unset.
 *  This is the only config that persists; env + auto-detect are ephemeral. */
async function storedConfig(): Promise<SourcebotConfig | null> {
  const rawBase = unwrap(await callCateApi('cate.storage.get', { key: KEY_BASE_URL }))
  const baseUrl = normalizeBaseUrl(rawBase)
  if (!baseUrl) return null
  const rawKey = unwrap(await callCateApi('cate.storage.get', { key: KEY_API_KEY }))
  const apiKey = typeof rawKey === 'string' && rawKey.trim() ? rawKey.trim() : undefined
  return { baseUrl, apiKey }
}

/** Config from SOURCEBOT_URL / SOURCEBOT_API_KEY env, or null if unset. */
function envConfig(): SourcebotConfig | null {
  const baseUrl = normalizeBaseUrl(process.env[ENV_URL])
  if (!baseUrl) return null
  const apiKey = (process.env[ENV_KEY] || '').trim() || undefined
  return { baseUrl, apiKey }
}

// Auto-detection (the convention default + a docker/lsof scan for a "sourcebot"
// listener) is probe-gated and a little costly, so cache it briefly — the search
// and /sb proxy routes resolve config on every request.
let autoCache: { cfg: SourcebotConfig | null; at: number } | null = null
const AUTO_TTL_MS = 5000

async function autoConfig(): Promise<SourcebotConfig | null> {
  const now = Date.now()
  if (autoCache && now - autoCache.at < AUTO_TTL_MS) return autoCache.cfg
  const r = await detectService({
    candidates: [DEFAULT_URL],
    probePath: '/',
    processMatch: /sourcebot/i,
  })
  const cfg = r.baseUrl ? { baseUrl: r.baseUrl } : null
  autoCache = { cfg, at: now }
  if (cfg) console.log(`sourcebot: auto-detected ${cfg.baseUrl} (via ${r.via})`)
  return cfg
}

/** Resolve the effective Sourcebot: manual (saved) -> env -> auto-detected. */
async function resolveConfig(): Promise<{
  cfg: SourcebotConfig | null
  source: 'manual' | 'env' | 'auto' | null
}> {
  const stored = await storedConfig()
  if (stored) return { cfg: stored, source: 'manual' }
  const env = envConfig()
  if (env) return { cfg: env, source: 'env' }
  const auto = await autoConfig()
  if (auto) return { cfg: auto, source: 'auto' }
  return { cfg: null, source: null }
}

// --- static panel assets -----------------------------------------------------

const STATIC: Record<string, { file: string; type: string }> = {
  '/app.js': { file: 'public/app.js', type: 'text/javascript; charset=utf-8' },
  '/app.css': { file: 'public/app.css', type: 'text/css; charset=utf-8' },
}

function readPublic(rel: string): Buffer {
  return fs.readFileSync(path.join(__dirname, rel))
}

// CSP: our own script only, but allow same-origin fetch (search) AND framing our
// own /sb/ proxy path (Sourcebot UI is reverse-proxied same-origin, so 'self'
// covers it). No third-party origins are reachable from the webview.
const PAGE_CSP =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; " +
  "font-src 'self' data:; " +
  "connect-src 'self'; " +
  "frame-src 'self'; " +
  "child-src 'self'; " +
  'frame-ancestors *'

function sendJson(res: http.ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', () => resolve(Buffer.alloc(0)))
  })
}

// --- reverse-proxy of the Sourcebot web UI (for the embedded iframe) ----------
//
// Forward /sb/<rest> to <baseUrl>/<rest>. We rewrite Location headers that point
// back at Sourcebot's root so navigations stay inside our /sb/ prefix, and we
// strip framing guards (X-Frame-Options / frame-ancestors) so Sourcebot renders
// inside the panel iframe. Best-effort: Sourcebot is a full Next.js app and some
// deep links may not survive subpath proxying — the NATIVE search path is the
// primary, fully-supported surface; the iframe is a convenience browse mode.

async function proxySourcebot(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cfg: SourcebotConfig,
  rest: string,
  query: string,
): Promise<void> {
  const upstreamPath = '/' + rest + query
  const body = req.method && req.method !== 'GET' && req.method !== 'HEAD' ? await readBody(req) : undefined
  // Pass through a minimal, safe set of request headers.
  const fwdHeaders: Record<string, string> = {}
  const accept = req.headers['accept']
  const ct = req.headers['content-type']
  if (typeof accept === 'string') fwdHeaders['Accept'] = accept
  if (typeof ct === 'string') fwdHeaders['Content-Type'] = ct

  let upstream
  try {
    upstream = await requestUpstream(cfg, upstreamPath, { method: req.method, body, headers: fwdHeaders })
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'text/plain' })
    res.end('Sourcebot unreachable: ' + (err instanceof Error ? err.message : String(err)))
    return
  }

  const headers: http.OutgoingHttpHeaders = {}
  for (const [k, v] of Object.entries(upstream.headers)) {
    const lk = k.toLowerCase()
    // Drop framing/CSP guards so the proxied UI renders inside our iframe.
    if (lk === 'x-frame-options' || lk === 'content-security-policy') continue
    if (lk === 'content-length') continue // body may be rewritten/streamed as-is
    if (lk === 'location' && typeof v === 'string') {
      headers['location'] = rewriteLocation(v, cfg.baseUrl)
      continue
    }
    if (v != null) headers[lk] = v as string | string[]
  }
  res.writeHead(upstream.status, headers)
  res.end(upstream.body)
}

// --- request handler ---------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const pathname = url.pathname

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

  // Panel HTML.
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
      res.writeHead(200, {
        'Content-Type': asset.type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      })
      res.end(readPublic(asset.file))
    } catch {
      res.writeHead(404).end('Not found')
    }
    return
  }

  // Config status for the panel: is a Sourcebot configured, and is it reachable?
  if (pathname === '/api/config' && req.method === 'GET') {
    let cfg: SourcebotConfig | null = null
    let source: 'manual' | 'env' | 'auto' | null = null
    try {
      ;({ cfg, source } = await resolveConfig())
    } catch (err) {
      sendJson(res, 200, { configured: false, error: err instanceof Error ? err.message : String(err) })
      return
    }
    if (!cfg) {
      sendJson(res, 200, { configured: false })
      return
    }
    const p = await probe(cfg)
    sendJson(res, 200, {
      configured: true,
      source,
      baseUrl: cfg.baseUrl,
      hasKey: Boolean(cfg.apiKey),
      reachable: p.reachable,
      probeStatus: p.status,
      probeError: p.error,
    })
    return
  }

  // Native search: forward to Sourcebot /api/search, normalize to flat hits.
  if (pathname === '/sbapi/search' && req.method === 'POST') {
    let cfg: SourcebotConfig | null
    try {
      cfg = (await resolveConfig()).cfg
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
      return
    }
    if (!cfg) {
      sendJson(res, 400, { error: 'not-configured' })
      return
    }
    const raw = (await readBody(req)).toString('utf8')
    let input: { query?: unknown; matches?: unknown; isRegexEnabled?: unknown; isCaseSensitivityEnabled?: unknown }
    try {
      input = raw ? JSON.parse(raw) : {}
    } catch {
      sendJson(res, 400, { error: 'bad-json' })
      return
    }
    const query = typeof input.query === 'string' ? input.query.trim() : ''
    if (!query) {
      sendJson(res, 400, { error: 'empty-query' })
      return
    }
    const sbBody = Buffer.from(
      JSON.stringify({
        query,
        matches: clampMatches(input.matches),
        contextLines: 1,
        isRegexEnabled: input.isRegexEnabled === true,
        isCaseSensitivityEnabled: input.isCaseSensitivityEnabled === true,
      }),
      'utf8',
    )
    try {
      const up = await requestUpstream(cfg, '/api/search', {
        method: 'POST',
        body: sbBody,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      })
      if (up.status < 200 || up.status >= 300) {
        sendJson(res, 200, {
          error: 'upstream',
          status: up.status,
          detail: up.body.toString('utf8').slice(0, 500),
        })
        return
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(up.body.toString('utf8'))
      } catch {
        sendJson(res, 200, { error: 'upstream-not-json' })
        return
      }
      sendJson(res, 200, { ok: true, ...normalizeSearchResponse(parsed) })
    } catch (err) {
      sendJson(res, 200, { error: 'unreachable', detail: err instanceof Error ? err.message : String(err) })
    }
    return
  }

  // Reverse-proxy the Sourcebot web UI for the embedded iframe browse mode.
  if (pathname === '/sb' || pathname.startsWith('/sb/')) {
    let cfg: SourcebotConfig | null
    try {
      cfg = (await resolveConfig()).cfg
    } catch (err) {
      res.writeHead(500).end(err instanceof Error ? err.message : String(err))
      return
    }
    if (!cfg) {
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end('Sourcebot not configured')
      return
    }
    const rest = pathname === '/sb' ? '' : pathname.slice('/sb/'.length)
    const queryIdx = (req.url || '').indexOf('?')
    const query = queryIdx >= 0 ? (req.url || '').slice(queryIdx) : ''
    await proxySourcebot(req, res, cfg, rest, query)
    return
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('Not found')
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`sourcebot ext listening on 127.0.0.1:${PORT} (workspace: ${WORKSPACE_ROOT})`)
})
