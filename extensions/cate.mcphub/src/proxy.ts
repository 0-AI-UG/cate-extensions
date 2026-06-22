// =============================================================================
// Reverse-proxy helpers: forward HTTP + WebSocket/SSE from the loopback-bound
// wrapper to the internal MCPHub child, and poll the child for readiness.
//
// Dependency-free (Node http + net only) so the shipped dist/ needs no runtime
// node_modules — the same constraint the kitchensink reference observes.
// =============================================================================

import http from 'http'
import net from 'net'
import { Socket } from 'net'

/** Poll an internal HTTP endpoint until it answers, or time out. MCPHub has no
 *  /health route, so "ready" = the root responds with any HTTP status (even a
 *  302 redirect or 404), which means the listener is up. */
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

/** Forward one HTTP request/response pair to the internal MCPHub. Strips the
 *  hop-by-hop Authorization the proxy injected (MCPHub has its own auth) and
 *  preserves the rest. Errors yield a 502 the panel can show. */
export function forwardHttp(
  internalPort: number,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const headers: http.OutgoingHttpHeaders = { ...req.headers }
  // The wrapper's bearer is between Cate's proxy and us; don't leak it upstream.
  delete headers['authorization']
  // Rewrite Host so MCPHub's redirects/absolute URLs point back at the wrapper
  // port the browser actually talks to.
  headers['host'] = `127.0.0.1:${internalPort}`

  const upstream = http.request(
    {
      hostname: '127.0.0.1',
      port: internalPort,
      path: req.url || '/',
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
    res.end(`MCPHub upstream error: ${err.message}`)
  })
  req.pipe(upstream)
}

/** Forward a WebSocket (or other) upgrade to the internal MCPHub. MCPHub uses
 *  SSE for MCP transport, but a raw socket tunnel covers WS upgrades too. */
export function forwardUpgrade(
  internalPort: number,
  req: http.IncomingMessage,
  clientSocket: Socket,
  head: Buffer,
): void {
  const headers: http.OutgoingHttpHeaders = { ...req.headers }
  delete headers['authorization']
  headers['host'] = `127.0.0.1:${internalPort}`

  const upstream = http.request({
    hostname: '127.0.0.1',
    port: internalPort,
    path: req.url || '/',
    method: req.method,
    headers,
  })

  upstream.on('upgrade', (upRes, upSocket: Socket, upHead: Buffer) => {
    const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}`]
    for (const [k, v] of Object.entries(upRes.headers)) {
      if (Array.isArray(v)) for (const vv of v) lines.push(`${k}: ${vv}`)
      else if (v != null) lines.push(`${k}: ${v}`)
    }
    clientSocket.write(lines.join('\r\n') + '\r\n\r\n')
    if (upHead && upHead.length) clientSocket.write(upHead)
    upSocket.pipe(clientSocket)
    clientSocket.pipe(upSocket)
    const drop = (): void => {
      upSocket.destroy()
      clientSocket.destroy()
    }
    upSocket.on('error', drop)
    clientSocket.on('error', drop)
  })

  upstream.on('error', () => clientSocket.destroy())
  if (head && head.length) upstream.write(head)
  upstream.end()
}

/** Find a free loopback TCP port for the internal MCPHub. Asks the OS for an
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
