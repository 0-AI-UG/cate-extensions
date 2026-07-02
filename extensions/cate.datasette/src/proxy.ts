// =============================================================================
// Reverse-proxy helpers: forward HTTP from the loopback-bound wrapper to the
// internal Datasette child, and poll the child for readiness.
//
// Dependency-free (Node http + net only) so the shipped dist/ needs no runtime
// node_modules — the same constraint the other server-backed extensions observe.
// =============================================================================

import http from 'http'
import net from 'net'

/** Poll an internal HTTP endpoint until it answers, or time out. "Ready" = the
 *  probed path responds with any HTTP status, which means the listener is up
 *  (Datasette answers its base_url with 200 once serving). */
export function waitForReady(
  internalPort: number,
  opts: { timeoutMs?: number; intervalMs?: number; path?: string } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 30000
  const intervalMs = opts.intervalMs ?? 300
  const path = opts.path ?? '/'
  const deadline = Date.now() + timeoutMs

  return new Promise((resolve) => {
    const attempt = (): void => {
      const req = http.request(
        { hostname: '127.0.0.1', port: internalPort, path, method: 'GET', timeout: 2000 },
        (res) => {
          // Any response status means the listener is accepting connections.
          res.resume()
          resolve(true)
        },
      )
      req.on('error', retry)
      req.on('timeout', () => {
        req.destroy()
        retry()
      })
      req.end()
    }
    const retry = (): void => {
      if (Date.now() >= deadline) {
        resolve(false)
        return
      }
      setTimeout(attempt, intervalMs)
    }
    attempt()
  })
}

/** Forward one HTTP request/response pair to the internal Datasette at
 *  `upstreamPath` (the wrapper re-adds the public prefix Cate's proxy stripped,
 *  since the child serves under its base_url). Strips the hop-by-hop
 *  Authorization the proxy injected. Errors yield a 502 the panel can show. */
export function forwardHttp(
  internalPort: number,
  upstreamPath: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const headers: http.OutgoingHttpHeaders = { ...req.headers }
  // The wrapper's bearer is between Cate's proxy and us; don't leak it upstream.
  delete headers['authorization']
  headers['host'] = `127.0.0.1:${internalPort}`

  const upstream = http.request(
    {
      hostname: '127.0.0.1',
      port: internalPort,
      path: upstreamPath,
      method: req.method,
      headers,
    },
    (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers)
      upRes.pipe(res)
    },
  )
  upstream.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' })
    }
    res.end(`Datasette upstream error: ${err.message}`)
  })
  req.pipe(upstream)
}

/** Find a free loopback TCP port for the internal Datasette. Asks the OS for an
 *  ephemeral port, then releases it; small TOCTOU window is acceptable here. */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr && typeof addr === 'object') {
        const port = addr.port
        srv.close(() => resolve(port))
      } else {
        srv.close(() => reject(new Error('could not determine free port')))
      }
    })
  })
}
