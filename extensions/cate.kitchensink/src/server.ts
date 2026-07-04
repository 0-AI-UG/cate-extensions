// Kitchen Sink server. Dependency-free at runtime (Node http + raw WS frames).
// Cate spawns it and injects env:
//   PORT           free loopback port to bind on 127.0.0.1
//   CATE_TOKEN     bearer the proxy injects on every request to us
//   WORKSPACE_ROOT workspace root path on the runtime host
//   CATE_API       loopback URL that tunnels back into Cate's reverse API
//
// Routes (all but /health require Authorization: Bearer <CATE_TOKEN>):
//   GET  /health             readiness probe (auth-exempt)
//   GET  /                   panel HTML
//   GET  /app.js, /style.css static assets
//   GET  /api/info           server info
//   POST /api/echo           echoes the JSON body
//   GET  /ws                 WebSocket echo
//   POST /api/cate-roundtrip server calls back into Cate over CATE_API
//   POST /api/agent-run      server runs one agent turn via cate.agent.run

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

// Every non-/health request must carry the proxy-injected bearer. The webview
// never holds the token; the proxy injects it on requests it forwards to us.
function authorized(req: http.IncomingMessage): boolean {
  const header = String(req.headers['authorization'] || '')
  return TOKEN.length > 0 && header === `Bearer ${TOKEN}`
}

// Call back into Cate from the server. CATE_API is a loopback URL that tunnels
// into Cate's reverse API; we authenticate with the same CATE_TOKEN.
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
  keysIncluded: boolean
  deleted: boolean
  notified: boolean
  version: unknown
}

/** cate.* over the reverse endpoint may wrap the value as { result }. Accept
 *  either shape. */
function unwrap(v: unknown): unknown {
  return v && typeof v === 'object' && 'result' in v ? (v as { result: unknown }).result : v
}

// Run storage.set/get/keys/delete + ui.notify + version over CATE_API.
async function cateRoundtrip(): Promise<RoundtripResult> {
  const key = 'kitchensink:roundtrip'
  const stamp = `kitchensink-${Date.now()}`

  await callCateApi('cate.storage.set', { key, value: stamp })
  const read = unwrap(await callCateApi('cate.storage.get', { key }))

  const keys = unwrap(await callCateApi('cate.storage.keys'))
  const keysIncluded = Array.isArray(keys) && keys.includes(key)

  await callCateApi('cate.storage.delete', { key })
  const afterDelete = unwrap(await callCateApi('cate.storage.get', { key }))
  const deleted = afterDelete == null

  const notifyRes = unwrap(await callCateApi('cate.ui.notify', {
    message: 'Kitchen Sink server round-trip',
    level: 'info',
  })) as { ok?: boolean } | undefined
  const notified = notifyRes?.ok === true

  const version = unwrap(await callCateApi('cate.version'))

  return {
    ok: read === stamp && keysIncluded && deleted && notified,
    wrote: stamp,
    read,
    keysIncluded,
    deleted,
    notified,
    version,
  }
}

// Static assets served from this file's own dir.
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

// External script only (no inline), but allow same-origin fetch and WebSocket
// through the proxy.
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const pathname = url.pathname

  // Readiness probe, auth-exempt so Cate's probe (no token yet) succeeds.
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

  // The server calls back into Cate via CATE_API.
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

  // The server runs one agent turn via cate.agent.run (needs the `agent` scope
  // and first-use consent). It resolves only when the agent finishes.
  if (pathname === '/api/agent-run' && req.method === 'POST') {
    const raw = await readBody(req)
    let prompt = ''
    try {
      prompt = String((JSON.parse(raw || '{}') as { prompt?: unknown }).prompt ?? '')
    } catch {
      /* keep '' */
    }
    if (!prompt.trim()) {
      sendJson(res, 400, { ok: false, error: 'prompt required' })
      return
    }
    try {
      const result = unwrap(await callCateApi('cate.agent.run', { prompt })) as
        | { text?: string; error?: string }
        | undefined
      if (result && typeof result.error === 'string') {
        sendJson(res, 200, { ok: false, error: result.error })
        return
      }
      sendJson(res, 200, { ok: true, text: result?.text ?? '' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      sendJson(res, 500, { ok: false, error: message })
    }
    return
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('Not found')
})

// WebSocket echo (raw RFC6455 frames, no deps). The proxy injects the bearer on
// the upgrade too, so we check it here.
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
    // A single TCP chunk may hold a partial/split frame; decodeTextFrame
    // bounds-checks and returns null, but guard anyway so a malformed frame
    // can never crash the process (demo echo, no multi-frame reassembly).
    try {
      const text = decodeTextFrame(buf)
      if (text != null) socket.write(encodeTextFrame(`echo: ${text}`))
    } catch {
      socket.destroy()
    }
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
    if (buf.length < 4) return null // extended-length header split across chunks
    len = buf.readUInt16BE(2)
    offset = 4
  } else if (len === 127) {
    if (buf.length < 10) return null // extended-length header split across chunks
    len = Number(buf.readBigUInt64BE(2))
    offset = 10
  }
  // Bail out if the declared payload (plus mask) runs past this chunk rather
  // than reading out of bounds — this demo doesn't reassemble split frames.
  if (buf.length < offset + (masked ? 4 : 0) + len) return null
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
