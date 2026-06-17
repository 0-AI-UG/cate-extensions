// =============================================================================
// Kitchen Sink — a server-backed Cate extension that exercises the WHOLE
// extension stack end to end. Dependency-free at runtime (Node http + raw WS
// frames), so the shipped .tgz carries only compiled JS, no node_modules.
// Authored in TypeScript; `npm run build` compiles this to dist/server.js.
//
// Cate spawns this on the workspace's runtime host with:
//   PORT           — a free loopback port we MUST bind on 127.0.0.1
//   CATE_TOKEN     — the bearer the proxy injects on every request to us
//   WORKSPACE_ROOT — the workspace root path on the runtime host
//   CATE_API       — http://127.0.0.1:<port> loopback that tunnels BACK into
//                    Cate's reverse API (authenticated with CATE_TOKEN)
//
// Routes (all but /health require Authorization: Bearer <CATE_TOKEN>):
//   GET  /health             -> 200 (the readiness probe; auth-exempt)
//   GET  /                   -> the panel HTML
//   GET  /app.js, /style.css -> static assets (CSP-safe: external script)
//   GET  /api/info           -> { workspaceRoot, pid, time, ... }   [HTTP tunnel]
//   POST /api/echo           -> echoes the JSON body                [HTTP tunnel]
//   GET  /ws                 -> WebSocket echo                      [WS tunnel]
//   POST /api/cate-roundtrip -> server calls CATE_API storage.set+get [reverse]
//
// Each route proves a specific layer of the stack; the page labels them.
// =============================================================================

import http from 'http'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

const PORT = Number(process.env.PORT)
const TOKEN = process.env.CATE_TOKEN || ''
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || '(none)'
const CATE_API = process.env.CATE_API || ''
const STARTED_AT = new Date().toISOString()

if (!PORT) {
  console.error('kitchensink: PORT not set by Cate; refusing to start')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Auth — every non-/health request must carry the proxy-injected bearer. The
// webview never holds the token; if these checks pass we KNOW the proxy
// injected it on our behalf.
// ---------------------------------------------------------------------------

function authorized(req: http.IncomingMessage): boolean {
  const header = String(req.headers['authorization'] || '')
  return TOKEN.length > 0 && header === `Bearer ${TOKEN}`
}

// ---------------------------------------------------------------------------
// CATE_API reverse channel — call BACK into Cate from the server. Cate injects
// CATE_API as a loopback URL on this host that tunnels into Cate's reverse API.
// We authenticate with the same CATE_TOKEN. Proves the server -> Cate path.
// ---------------------------------------------------------------------------

function callCateApi(method: string, args?: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!CATE_API) {
      reject(new Error('CATE_API not set'))
      return
    }
    const body = JSON.stringify({ method, args: args || {} })
    const u = new URL(CATE_API)
    const opts: http.RequestOptions = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname || '/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: `Bearer ${TOKEN}`,
      },
    }
    const r = http.request(opts, (res) => {
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
    })
    r.on('error', reject)
    r.end(body)
  })
}

interface RoundtripResult {
  ok: boolean
  wrote: string
  read: unknown
}

/** Run a storage set + get round-trip through CATE_API and report the result. */
async function cateRoundtrip(): Promise<RoundtripResult> {
  const stamp = `kitchensink-${Date.now()}`
  await callCateApi('cate.storage.set', { key: 'kitchensink:roundtrip', value: stamp })
  const got = await callCateApi('cate.storage.get', { key: 'kitchensink:roundtrip' })
  // dispatchStorage returns the raw value for storage.get; cate.storage.get over
  // the reverse endpoint may wrap it as { result }. Accept either shape.
  const read =
    got && typeof got === 'object' && 'result' in got
      ? (got as { result: unknown }).result
      : got
  return { ok: read === stamp, wrote: stamp, read }
}

// ---------------------------------------------------------------------------
// Static assets — served from this file's own dir (CSP-safe, external script).
// ---------------------------------------------------------------------------

interface StaticAsset {
  file: string
  type: string
}

const STATIC: Record<string, StaticAsset> = {
  '/app.js': { file: 'public/app.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'public/style.css', type: 'text/css; charset=utf-8' },
}

function readPublic(rel: string): Buffer {
  return fs.readFileSync(path.join(__dirname, rel))
}

// A tight CSP: external script only (no inline), but allow the page to fetch
// its own origin and open a same-origin WebSocket through the proxy. This is
// required for ANY server-backed extension page that talks to its own server.
const PAGE_CSP =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "font-src 'self' data:; " +
  "connect-src 'self' ws: wss:; " +
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

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
  })
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const pathname = url.pathname

  // Readiness probe — auth-exempt so Cate's probe (no token yet) succeeds.
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('ok')
    return
  }

  // Everything else requires the injected bearer token.
  if (!authorized(req)) {
    res.writeHead(401, { 'Content-Type': 'text/plain' })
    res.end('Unauthorized: missing or wrong Bearer token')
    return
  }

  // The panel HTML.
  if (pathname === '/' || pathname === '') {
    const html = readPublic('public/index.html')
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': PAGE_CSP,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(html)
    return
  }

  // Static assets.
  const asset = STATIC[pathname]
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

  // GET /api/info — proves an HTTP request from the page tunnels to us.
  if (pathname === '/api/info' && req.method === 'GET') {
    sendJson(res, 200, {
      workspaceRoot: WORKSPACE_ROOT,
      pid: process.pid,
      time: new Date().toISOString(),
      startedAt: STARTED_AT,
      node: process.version,
      cateApiConfigured: Boolean(CATE_API),
    })
    return
  }

  // POST /api/echo — echoes the request body back, proving a round-trip.
  if (pathname === '/api/echo' && req.method === 'POST') {
    const raw = await readBody(req)
    let parsed: unknown
    try {
      parsed = raw ? JSON.parse(raw) : null
    } catch {
      parsed = null
    }
    sendJson(res, 200, { echoed: parsed, raw, receivedAt: new Date().toISOString() })
    return
  }

  // POST /api/cate-roundtrip — the SERVER calls back into Cate via CATE_API.
  if (pathname === '/api/cate-roundtrip' && req.method === 'POST') {
    try {
      const result = await cateRoundtrip()
      sendJson(res, 200, result)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      sendJson(res, 500, { ok: false, error: message })
    }
    return
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('Not found')
})

// ---------------------------------------------------------------------------
// WebSocket echo (raw RFC6455 frames, no deps) — proves WS upgrade tunneling.
// The proxy injects the bearer on the upgrade too, so we check it here.
// ---------------------------------------------------------------------------

server.on('upgrade', (req, socket) => {
  if (!authorized(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.destroy()
    return
  }
  const key = req.headers['sec-websocket-key']
  if (!key) {
    socket.destroy()
    return
  }
  const accept = crypto
    .createHash('sha1')
    .update(String(key) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )

  socket.on('data', (buf: Buffer) => {
    const text = decodeTextFrame(buf)
    if (text != null) socket.write(encodeTextFrame(`echo: ${text}`))
  })
  socket.on('error', () => socket.destroy())
})

function decodeTextFrame(buf: Buffer): string | null {
  if (buf.length < 2) return null
  const opcode = buf[0] & 0x0f
  if (opcode === 0x8) return null // close
  if (opcode !== 0x1) return null // only text
  const masked = (buf[1] & 0x80) !== 0
  let len = buf[1] & 0x7f
  let offset = 2
  if (len === 126) {
    len = buf.readUInt16BE(2)
    offset = 4
  } else if (len === 127) {
    len = Number(buf.readBigUInt64BE(2))
    offset = 10
  }
  let payload: Buffer
  if (masked) {
    const mask = buf.slice(offset, offset + 4)
    offset += 4
    payload = Buffer.alloc(len)
    for (let i = 0; i < len; i++) payload[i] = buf[offset + i] ^ mask[i % 4]
  } else {
    payload = buf.slice(offset, offset + len)
  }
  return payload.toString('utf8')
}

function encodeTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8')
  const len = payload.length
  let header: Buffer
  if (len < 126) {
    header = Buffer.from([0x81, len])
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, payload])
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`kitchensink listening on 127.0.0.1:${PORT} (workspace: ${WORKSPACE_ROOT})`)
})
