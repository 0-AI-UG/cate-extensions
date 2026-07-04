// =============================================================================
// Shared HTTP primitives for server-backed extensions.
//
// Every server extension Cate spawns speaks the same contract: bind 127.0.0.1
// on $PORT, expose an auth-exempt GET /health readiness probe, gate everything
// else on the proxy-injected `Authorization: Bearer $CATE_TOKEN`, and serve its
// panel's static assets with a tight CSP. These helpers are the one place that
// scaffolding lives so the servers can't drift (they had already diverged — an
// unbounded request body in one, a body cap in another). Domain routing stays
// in each extension; only the transport plumbing is shared.
//
// Node-only (imports `http`); synced into each server consumer's
// `src/_kitserver/` by scripts/sync-kit.mjs, which the Node tsconfigs include
// and the browser tsconfigs do not.
// =============================================================================

import http from 'http'
import fs from 'fs'
import path from 'path'

/** Max request body we buffer before rejecting (2 MB). */
export const BODY_LIMIT = 2_000_000

/** Tight CSP for a panel that renders into its own DOM: own scripts + inline
 *  styles only, same-origin fetch, data: images/fonts. */
export const PANEL_CSP =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "font-src 'self' data:; " +
  "connect-src 'self'; " +
  'frame-ancestors *'

/** Like PANEL_CSP but also allows same-origin WebSocket (proxied ws:/wss:). */
export const PANEL_CSP_WS = PANEL_CSP.replace("connect-src 'self'", "connect-src 'self' ws: wss:")

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

/** Content-Type for a file path (by extension), or octet-stream. */
export function mimeFor(file: string): string {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'
}

/** Write a JSON response with no-store caching. */
export function sendJson(res: http.ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

/** Buffer the request body as UTF-8, capped at `limit`. Resolves '' on a
 *  transport error; rejects if the body exceeds `limit` (and destroys the
 *  request) so a client can't exhaust memory. */
export function readBody(req: http.IncomingMessage, limit = BODY_LIMIT): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
  })
}

/** Parse the request body as a JSON object, or null if it isn't one. */
export async function readJsonObject(
  req: http.IncomingMessage,
  limit = BODY_LIMIT,
): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readBody(req, limit))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/** True when the request carries the exact proxy-injected bearer token. */
export function isAuthorized(req: http.IncomingMessage, token: string): boolean {
  const header = String(req.headers['authorization'] || '')
  return token.length > 0 && header === `Bearer ${token}`
}

/** Answer the auth-exempt readiness probe. Returns true if it handled the
 *  request (caller should return early). */
export function handleHealth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname
  if (pathname !== '/health') return false
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end('ok')
  return true
}

/** 401 for a request missing/failing the bearer check. */
export function sendUnauthorized(res: http.ServerResponse): void {
  res.writeHead(401, { 'Content-Type': 'text/plain' })
  res.end('Unauthorized')
}

/** Serve raw bytes with no-store + nosniff, and a CSP if given (for HTML). */
export function sendBytes(
  res: http.ServerResponse,
  data: Buffer,
  type: string,
  csp?: string,
): void {
  const headers: Record<string, string> = {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  }
  if (csp) headers['Content-Security-Policy'] = csp
  res.writeHead(200, headers)
  res.end(data)
}

/** Read + serve a file under `rootDir`, refusing paths that escape it. A root
 *  request ("" or "/") maps to index.html. Sets the CSP on HTML responses.
 *  Always handles the request (serves the file, or sends 403/404); returns true
 *  for symmetry with the other `handle*` helpers. */
export function serveStaticFile(
  res: http.ServerResponse,
  rootDir: string,
  relPath: string,
  csp = PANEL_CSP,
): boolean {
  const rel = relPath === '/' || relPath === '' ? 'index.html' : relPath.replace(/^\/+/, '')
  const abs = path.normalize(path.join(rootDir, rel))
  if (abs !== rootDir && !abs.startsWith(rootDir + path.sep)) {
    res.writeHead(403).end('Forbidden')
    return true
  }
  let data: Buffer
  try {
    data = fs.readFileSync(abs)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found')
    return true
  }
  const ext = path.extname(abs).toLowerCase()
  sendBytes(res, data, mimeFor(abs), ext === '.html' ? csp : undefined)
  return true
}

/** Call back into Cate over the reverse API. CATE_API is a loopback URL that
 *  tunnels into Cate; the same CATE_TOKEN authenticates. Resolves the parsed
 *  JSON reply (or raw text), rejects on a non-200. */
export function callHostApi(
  cateApiUrl: string,
  token: string,
  method: string,
  args?: Record<string, unknown>,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!cateApiUrl) {
      reject(new Error('CATE_API not set'))
      return
    }
    const body = JSON.stringify({ method, args: args || {} })
    const u = new URL(cateApiUrl)
    const r = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname || '/',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${text}`))
            return
          }
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
