// =============================================================================
// Proxyscotch-compatible request proxy (pure codec half).
//
// Hoppscotch's "Proxy" interceptor executes API requests through a Proxyscotch
// server (hoppscotch/proxyscotch) instead of the browser, dodging CORS. This
// wrapper offers the same wire protocol on POST <CONTROL_PREFIX>/proxy so the
// embedded Hoppscotch (or the hosted app) can run requests through Cate's
// loopback, where the webview's own network restrictions don't apply.
//
// Protocol (mirrors libproxy/proxy.go):
//   GET  -> { success: true, data: { sessionFingerprint, isProtected } }
//           (the app pings this to validate a proxy URL)
//   POST -> body { method, url, headers?, params?, data?, wantsBinary?,
//                  auth?: { username, password }, accessToken? }
//        -> { success: true, isBinary, status, statusText, headers, data }
//           data is the raw text, or UNPADDED base64 (Go base64.RawStdEncoding)
//           when wantsBinary. Errors come back as HTTP 200 with
//           { success: false, data: { message } } — exactly what the client
//           expects to render.
//
// This file is the pure request-parse / response-encode half so it unit-tests
// without sockets; the actual fetch loop lives in server.ts.
// =============================================================================

export interface ProxyRequest {
  method: string
  url: string
  headers: Record<string, string>
  params: Record<string, string>
  data: string
  wantsBinary: boolean
  auth: { username: string; password: string } | null
}

export type ParseResult = { ok: true; req: ProxyRequest } | { ok: false; message: string }

/** Error body in the exact shape the Hoppscotch client renders. */
export function errorBody(message: string): string {
  return JSON.stringify({ success: false, data: { message: `(Proxy Error) ${message}` } })
}

/** The non-POST greeting the app uses to validate a proxy URL. Cate's own
 *  bearer already gates every request, so no separate access token is imposed. */
export function greetingBody(sessionFingerprint: string): string {
  return JSON.stringify({
    success: true,
    data: { sessionFingerprint, isProtected: false },
  })
}

function stringMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v
      else if (v != null && typeof v !== 'object') out[k] = String(v)
    }
  }
  return out
}

/** Parse + validate a proxy request body. Only http(s) targets are accepted —
 *  this endpoint must not become a file:///raw-socket springboard. */
export function parseProxyRequest(raw: string): ParseResult {
  let body: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, message: 'Invalid request.' }
    }
    body = parsed as Record<string, unknown>
  } catch {
    return { ok: false, message: 'Invalid request.' }
  }

  const method = typeof body.method === 'string' ? body.method.trim().toUpperCase() : ''
  const url = typeof body.url === 'string' ? body.url.trim() : ''
  if (!method || !url) return { ok: false, message: 'Invalid request.' }
  if (!/^[A-Z]+$/.test(method)) return { ok: false, message: 'Invalid method.' }

  let target: URL
  try {
    target = new URL(url)
  } catch {
    return { ok: false, message: `Invalid URL: ${url}` }
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return { ok: false, message: 'Request cannot be to this destination.' }
  }

  const authRaw = body.auth as { username?: unknown; password?: unknown } | undefined
  const auth =
    authRaw &&
    typeof authRaw === 'object' &&
    typeof authRaw.username === 'string' &&
    typeof authRaw.password === 'string' &&
    authRaw.username.length > 0 &&
    authRaw.password.length > 0
      ? { username: authRaw.username, password: authRaw.password }
      : null

  return {
    ok: true,
    req: {
      method,
      url,
      headers: stringMap(body.headers),
      params: stringMap(body.params),
      data: typeof body.data === 'string' ? body.data : '',
      wantsBinary: body.wantsBinary === true,
      auth,
    },
  }
}

/** The final target URL: request URL with `params` merged into its query
 *  (params win on duplicate keys, matching proxyscotch's Set semantics). */
export function buildTargetUrl(req: ProxyRequest): string {
  const u = new URL(req.url)
  for (const [k, v] of Object.entries(req.params)) u.searchParams.set(k, v)
  return u.toString()
}

/** Lowercased single-valued header map, matching proxyscotch's headerToArray
 *  (last value wins for repeated headers). */
export function flattenHeaders(raw: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw)) {
    if (value == null) continue
    out[name.toLowerCase()] = Array.isArray(value) ? value[value.length - 1] : value
  }
  return out
}

/** Encode a completed upstream response as the proxyscotch success body.
 *  Binary payloads use UNPADDED base64 (Go's base64.RawStdEncoding). */
export function successBody(args: {
  status: number
  statusText: string
  headers: Record<string, string | string[] | undefined>
  body: Buffer
  wantsBinary: boolean
}): string {
  const data = args.wantsBinary
    ? args.body.toString('base64').replace(/=+$/, '')
    : args.body.toString('utf8')
  return JSON.stringify({
    success: true,
    isBinary: args.wantsBinary,
    status: args.status,
    statusText: args.statusText,
    headers: flattenHeaders(args.headers),
    data,
  })
}
