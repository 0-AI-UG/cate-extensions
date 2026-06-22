// =============================================================================
// Thin HTTP client for the user's Sourcebot instance, dependency-free (Node
// http/https). Kept separate from server.ts so the request-building is unit
// testable and the server file stays focused on routing.
//
// The extension never bundles Sourcebot — it talks to a URL the USER configures
// (see STATUS.md, license gate). The API key (if any) is injected here,
// server-side, so the sandboxed webview never holds it.
// =============================================================================

import http from 'http'
import https from 'https'
import { URL } from 'url'
import { joinUrl } from './sourcebot'

export interface SourcebotConfig {
  baseUrl: string
  apiKey?: string
}

export interface UpstreamResponse {
  status: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}

/** Apply Sourcebot auth headers (both header forms it accepts) when a key is set. */
export function authHeaders(apiKey: string | undefined): Record<string, string> {
  if (!apiKey) return {}
  return {
    'X-Sourcebot-Api-Key': apiKey,
    Authorization: `Bearer ${apiKey}`,
  }
}

function agentFor(protocol: string): typeof http | typeof https {
  return protocol === 'https:' ? https : http
}

/**
 * Make one request to the user's Sourcebot. `upstreamPath` begins with "/".
 * Returns the buffered response; rejects only on transport errors (a non-2xx
 * upstream is still resolved so the caller can forward the status verbatim).
 */
export function requestUpstream(
  cfg: SourcebotConfig,
  upstreamPath: string,
  opts: { method?: string; body?: Buffer; headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<UpstreamResponse> {
  return new Promise((resolve, reject) => {
    let target: URL
    try {
      target = new URL(joinUrl(cfg.baseUrl, upstreamPath))
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
      return
    }
    const lib = agentFor(target.protocol)
    const headers: Record<string, string> = {
      ...authHeaders(cfg.apiKey),
      ...(opts.headers ?? {}),
    }
    if (opts.body) headers['Content-Length'] = String(opts.body.length)

    const req = lib.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: target.pathname + target.search,
        method: opts.method ?? 'GET',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 502, headers: res.headers, body: Buffer.concat(chunks) }),
        )
      },
    )
    req.on('error', reject)
    req.setTimeout(opts.timeoutMs ?? 15_000, () => {
      req.destroy(new Error('upstream timeout'))
    })
    if (opts.body) req.write(opts.body)
    req.end()
  })
}

/**
 * Rewrite an upstream redirect that points at Sourcebot's root back under the
 * `/sb/` prefix our server proxies it under, so navigations stay inside the
 * panel iframe. Absolute same-origin and bare-relative locations are rewritten;
 * cross-origin locations are left untouched.
 */
export function rewriteLocation(location: string, baseUrl: string): string {
  try {
    const abs = new URL(location, baseUrl)
    const base = new URL(baseUrl)
    if (abs.origin === base.origin) {
      const rel = abs.pathname.replace(/^\//, '')
      return '/sb/' + rel + abs.search + abs.hash
    }
    return location
  } catch {
    if (location.startsWith('/')) return '/sb' + location
    return location
  }
}

/** A cheap reachability probe used by /api/config: any HTTP answer means "up". */
export async function probe(cfg: SourcebotConfig): Promise<{ reachable: boolean; status?: number; error?: string }> {
  try {
    const res = await requestUpstream(cfg, '/api/repos', { method: 'GET', timeoutMs: 6_000 })
    return { reachable: true, status: res.status }
  } catch (err) {
    return { reachable: false, error: err instanceof Error ? err.message : String(err) }
  }
}
