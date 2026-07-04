// =============================================================================
// cate.usage server.
//
// Cate spawns this and injects env:
//   PORT           free loopback port to bind (Cate's contract)
//   HOST           127.0.0.1 (we bind exactly this)
//   CATE_TOKEN     bearer the proxy injects on every request to us
//   WORKSPACE_ROOT workspace root path on the runtime host (unused: usage data
//                  is per-machine under ~/.claude, not per-workspace)
//
// Endpoints (everything but /health is token-gated):
//   GET  /health                 auth-exempt readiness probe
//   GET  / + /assets/*           the panel shell and its bundled JS/CSS
//   GET  /api/status             in-flight load progress (never blocks)
//   GET  /api/report?days=N      the full dashboard payload (summary tiles,
//                                zero-filled daily series, per-model table,
//                                recent sessions, monthly totals)
//   GET  /api/daily?days=N       daily series slice
//   GET  /api/sessions?limit=N   recent sessions slice
//   GET  /api/models             per-model breakdown slice
//   GET  /api/monthly            monthly totals slice
//   POST /api/refresh            drop the cache, re-read, return a fresh report
//
// The underlying load re-reads every JSONL under ~/.claude/projects, so all
// endpoints share one stale-while-revalidate cache (CACHE_TTL_MS); only the
// very first request and POST /api/refresh block on a full re-read.
// =============================================================================

import http from 'http'
import fs from 'fs'
import path from 'path'
import { createTtlCache } from './cache'
import {
  buildReport,
  clampInt,
  dailySeries,
  modelTable,
  monthlyTable,
  recentSessions,
  type RawUsage,
} from './shape'
import { loadUsage, localToday, type LoadProgress } from './usage'
import {
  PANEL_CSP,
  handleHealth,
  isAuthorized,
  sendBytes,
  sendJson,
  sendUnauthorized,
} from './_kitserver/http'

const PORT = Number(process.env.PORT)
const HOST = process.env.HOST || '127.0.0.1'
const TOKEN = process.env.CATE_TOKEN || ''

// Stale-while-revalidate window. The panel polls every 60s and always gets an
// instant answer; a poll on data older than this also kicks a background
// re-read (which can take tens of seconds on a long history).
const CACHE_TTL_MS = 120_000

if (!PORT) {
  console.error('cate.usage: PORT not set by Cate; refusing to start')
  process.exit(1)
}

// Progress of the in-flight load (null when idle), served by GET /api/status
// so the panel can show what the load is actually doing.
let loadProgress: LoadProgress | null = null

const cache = createTtlCache<RawUsage>(async () => {
  loadProgress = {
    phase: 'scan',
    files: null,
    offline: null,
    retry: false,
    phaseStartedAt: Date.now(),
    readEtaMs: null,
  }
  try {
    return await loadUsage((p) => {
      loadProgress = p
    })
  } finally {
    loadProgress = null
  }
}, CACHE_TTL_MS)

// --- static assets ---------------------------------------------------------------

interface StaticAsset {
  file: string
  type: string
}

const SHELL_STATIC: Record<string, StaticAsset> = {
  '/assets/app.js': { file: 'public/app.js', type: 'text/javascript; charset=utf-8' },
  '/assets/app.css': { file: 'public/app.css', type: 'text/css; charset=utf-8' },
}

function readPublic(rel: string): Buffer {
  return fs.readFileSync(path.join(__dirname, rel))
}

// --- API handlers ----------------------------------------------------------------

async function handleReport(url: URL, res: http.ServerResponse): Promise<void> {
  const raw = await cache.get()
  const report = buildReport(raw, localToday(), {
    days: url.searchParams.get('days') ?? undefined,
    sessionLimit: url.searchParams.get('sessions') ?? undefined,
  })
  sendJson(res, 200, report)
}

async function handleSlice(pathname: string, url: URL, res: http.ServerResponse): Promise<boolean> {
  const raw = await cache.get()
  switch (pathname) {
    case '/api/daily': {
      const days = clampInt(url.searchParams.get('days') ?? undefined, 7, 365, 30)
      sendJson(res, 200, { today: localToday(), daily: dailySeries(raw.daily, localToday(), days) })
      return true
    }
    case '/api/sessions': {
      const limit = clampInt(url.searchParams.get('limit') ?? undefined, 1, 100, 15)
      sendJson(res, 200, { sessions: recentSessions(raw.sessions, limit) })
      return true
    }
    case '/api/models':
      sendJson(res, 200, { models: modelTable(raw.daily) })
      return true
    case '/api/monthly':
      sendJson(res, 200, { monthly: monthlyTable(raw.monthly) })
      return true
    default:
      return false
  }
}

// --- HTTP server -----------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const pathname = url.pathname

  // Readiness probe, auth-exempt so Cate's probe (no token yet) succeeds.
  if (handleHealth(req, res)) return

  if (!isAuthorized(req, TOKEN)) {
    sendUnauthorized(res)
    return
  }

  try {
    // Shell page at the panel root.
    if (pathname === '/' || pathname === '') {
      sendBytes(res, readPublic('public/index.html'), 'text/html; charset=utf-8', PANEL_CSP)
      return
    }

    // Panel bundle assets.
    const asset = SHELL_STATIC[pathname]
    if (asset) {
      try {
        sendBytes(res, readPublic(asset.file), asset.type)
      } catch {
        res.writeHead(404).end('Not found')
      }
      return
    }

    // --- JSON API ---
    // Load-progress probe. Answered synchronously (never touches the cache) so
    // it stays responsive while a load is in flight.
    if (pathname === '/api/status' && req.method === 'GET') {
      sendJson(res, 200, {
        loading: loadProgress !== null,
        progress: loadProgress
          ? { ...loadProgress, phaseElapsedMs: Date.now() - loadProgress.phaseStartedAt }
          : null,
        loadedAt: cache.loadedAt(),
      })
      return
    }
    if (pathname === '/api/report' && req.method === 'GET') {
      await handleReport(url, res)
      return
    }
    if (pathname === '/api/refresh' && req.method === 'POST') {
      cache.invalidate()
      await handleReport(url, res)
      return
    }
    if (req.method === 'GET' && (await handleSlice(pathname, url, res))) return

    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not found')
  } catch (err) {
    console.error('cate.usage: request failed', err)
    if (!res.headersSent) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
    } else {
      res.end()
    }
  }
})

server.listen(PORT, HOST, () => {
  console.log(`cate.usage dashboard listening on ${HOST}:${PORT}`)
})
