import { describe, it, expect, afterEach } from 'vitest'
import http from 'http'
import { waitForReady, forwardHttp, findFreePort } from './proxy'

const servers: http.Server[] = []

function listen(handler: http.RequestListener): Promise<{ port: number; server: http.Server }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    servers.push(server)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve({ port: (addr as { port: number }).port, server })
    })
  })
}

afterEach(() => {
  while (servers.length) servers.pop()?.close()
})

describe('findFreePort', () => {
  it('returns a usable loopback port', async () => {
    const port = await findFreePort()
    expect(port).toBeGreaterThan(0)
    expect(port).toBeLessThan(65536)
  })
})

describe('waitForReady', () => {
  it('resolves true once the probed path answers (any status)', async () => {
    const probed: string[] = []
    const { port } = await listen((req, res) => {
      probed.push(req.url || '')
      // Datasette-like: base_url path answers 200; any status counts as ready.
      res.writeHead(200)
      res.end()
    })
    const ready = await waitForReady(port, {
      timeoutMs: 2000,
      intervalMs: 50,
      path: '/ext/tok/db/',
    })
    expect(ready).toBe(true)
    expect(probed[0]).toBe('/ext/tok/db/')
  })

  it('resolves false when nothing is listening before the deadline', async () => {
    // The bounded readiness poll is what keeps a dead Datasette from spinning
    // the panel forever — this pins the timeout actually firing.
    const port = await findFreePort() // free, but no listener
    const ready = await waitForReady(port, { timeoutMs: 600, intervalMs: 100 })
    expect(ready).toBe(false)
  })
})

describe('forwardHttp', () => {
  it('re-adds the public prefix, strips the bearer, and proxies body/status', async () => {
    const seen: { method?: string; url?: string; body: string; auth?: string } = { body: '' }
    const upstream = await listen((req, res) => {
      seen.method = req.method
      seen.url = req.url
      seen.auth = req.headers['authorization'] as string | undefined
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        seen.body = Buffer.concat(chunks).toString('utf8')
        res.writeHead(201, { 'x-up': 'yes' })
        res.end('upstream-said-hi')
      })
    })

    // The wrapper receives /db/* (Cate stripped the prefix) and forwards to the
    // child at <publicBase>db/* — the caller composes that upstream path.
    const proxy = await listen((req, res) => {
      forwardHttp(upstream.port, '/ext/tok' + (req.url || '/'), req, res)
    })

    const body = await new Promise<{ status: number; text: string; xup?: string }>((resolve) => {
      const r = http.request(
        {
          hostname: '127.0.0.1',
          port: proxy.port,
          path: '/db/data?sql=select+1',
          method: 'POST',
          headers: { authorization: 'Bearer wrapper-secret', 'content-type': 'text/plain' },
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () =>
            resolve({
              status: res.statusCode || 0,
              text: Buffer.concat(chunks).toString('utf8'),
              xup: res.headers['x-up'] as string | undefined,
            }),
          )
        },
      )
      r.end('hello-datasette')
    })

    expect(seen.method).toBe('POST')
    expect(seen.url).toBe('/ext/tok/db/data?sql=select+1')
    expect(seen.body).toBe('hello-datasette')
    // The wrapper's bearer must NOT be forwarded upstream to Datasette.
    expect(seen.auth).toBeUndefined()
    expect(body.status).toBe(201)
    expect(body.text).toBe('upstream-said-hi')
    expect(body.xup).toBe('yes')
  })

  it('returns 502 when the upstream is down', async () => {
    const deadPort = await findFreePort()
    const proxy = await listen((req, res) => {
      forwardHttp(deadPort, req.url || '/', req, res)
    })
    const result = await new Promise<{ status: number; text: string }>((resolve) => {
      http
        .request({ hostname: '127.0.0.1', port: proxy.port, path: '/', method: 'GET' }, (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () =>
            resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') }),
          )
        })
        .end()
    })
    expect(result.status).toBe(502)
    expect(result.text).toContain('Datasette upstream error')
  })
})
