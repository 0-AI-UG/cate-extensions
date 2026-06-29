// =============================================================================
// service-detect — server-side (Node) auto-detection shared by connect-style
// extensions (deepwiki, sourcebot). It answers one question: "is the service
// the user runs reachable, and at what URL?" so the panel can connect on its
// own and only fall back to a manual form when nothing is found.
//
//   1. Probe caller-supplied candidate URLs in order (env override, then the
//      convention default, e.g. http://localhost:3000).
//   2. If none answer, SCAN the host for a running instance — `docker ps`
//      (matched by image name) and `lsof` (matched by process name) — and probe
//      the ports they expose. Every scanned port is probe-gated, so a stale or
//      unrelated listener is never returned.
//
// Browser panels must NOT import this — it uses node: APIs and is excluded from
// each extension's browser typecheck. The parsers are pure and exported so the
// fiddly lsof/docker output handling is unit-testable without a host.
// =============================================================================

import { execFile } from 'node:child_process'
import http from 'node:http'
import https from 'node:https'

const LOOPBACK = '127.0.0.1'

export interface DetectInput {
  /** Ordered candidate base URLs (env override, convention default). Falsy entries are skipped. */
  candidates: Array<string | null | undefined>
  /** Path probed for liveness. Default '/'. */
  probePath?: string
  /** Per-probe timeout, ms. Default 1200. */
  timeoutMs?: number
  /** Process/image names to look for when scanning (e.g. /sourcebot/i). Omit to skip the scan. */
  processMatch?: RegExp
  /** Cap on scanned candidate ports actually probed. Default 12. */
  maxScan?: number
}

export interface DetectOutput {
  /** First reachable base URL, or null when nothing answered. */
  baseUrl: string | null
  /** How it was found. */
  via: 'candidate' | 'scan' | null
  /** Every URL probed, for diagnostics / logging. */
  tried: string[]
}

// --- pure helpers (exported for tests) --------------------------------------

/** Trim + normalize a candidate into an http(s) origin, or null if unusable.
 *  Accepts bare `host:port` (scheme defaults to http). */
export function normalizeCandidate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let s = raw.trim()
  if (!s) return null
  // A "scheme:" is only a scheme when followed by a slash or non-digit, so a
  // bare "localhost:3000" (port) still passes through and gets http:// prepended.
  if (/^[a-z][a-z0-9+.-]*:(\/|[^0-9])/i.test(s) && !/^https?:\/\//i.test(s)) return null
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s
  try {
    const u = new URL(s)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.origin
  } catch {
    return null
  }
}

/** Parse `lsof -nP -iTCP -sTCP:LISTEN` output into listening ports whose owning
 *  command name matches `match`. Command is lsof's first column (truncated). */
export function parseLsofPorts(stdout: string, match: RegExp): number[] {
  const ports = new Set<number>()
  for (const line of stdout.split('\n')) {
    const command = line.split(/\s+/, 1)[0]
    if (!command || !match.test(command)) continue
    // NAME column looks like `127.0.0.1:3000 (LISTEN)` or `*:3000 (LISTEN)`.
    const m = line.match(/:(\d{1,5})\b(?=[^:]*\(LISTEN\))/)
    if (m) {
      const port = Number(m[1])
      if (port > 0 && port < 65536) ports.add(port)
    }
  }
  return [...ports]
}

/** Parse `docker ps --format '{{.Image}}\t{{.Ports}}'` into host-published ports
 *  of containers whose image matches `match` (e.g. `0.0.0.0:3000->3000/tcp`). */
export function parseDockerPorts(stdout: string, match: RegExp): number[] {
  const ports = new Set<number>()
  for (const line of stdout.split('\n')) {
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const image = line.slice(0, tab)
    const portsField = line.slice(tab + 1)
    if (!match.test(image)) continue
    for (const m of portsField.matchAll(/:(\d{1,5})->/g)) {
      const port = Number(m[1])
      if (port > 0 && port < 65536) ports.add(port)
    }
  }
  return [...ports]
}

// --- host probing & scanning -------------------------------------------------

/** Run a command, resolving its stdout (empty string on any error — a missing
 *  `lsof`/`docker` is an expected, silent miss). */
function run(cmd: string, args: string[], timeoutMs = 1500): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (_err, stdout) => {
      resolve(stdout ? String(stdout) : '')
    })
  })
}

/** GET `base + probePath`; resolve true on any < 500 response, false otherwise. */
export function probeUrl(base: string, probePath = '/', timeoutMs = 1200): Promise<boolean> {
  return new Promise((resolve) => {
    let url: URL
    try {
      url = new URL(probePath, base)
    } catch {
      resolve(false)
      return
    }
    const lib = url.protocol === 'https:' ? https : http
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'GET',
        timeout: timeoutMs,
        // Self-hosted instances commonly use self-signed certs; liveness only.
        rejectUnauthorized: false,
      },
      (res) => {
        res.resume()
        const code = res.statusCode || 0
        resolve(code > 0 && code < 500)
      },
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.end()
  })
}

/** Listening loopback ports of processes/containers whose name matches `match`. */
async function scanPorts(match: RegExp): Promise<number[]> {
  const [lsof, docker] = await Promise.all([
    run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']),
    run('docker', ['ps', '--format', '{{.Image}}\t{{.Ports}}']),
  ])
  const ports = new Set<number>()
  for (const p of parseDockerPorts(docker, match)) ports.add(p)
  for (const p of parseLsofPorts(lsof, match)) ports.add(p)
  return [...ports]
}

/**
 * Resolve a reachable base URL for a user-run service: probe the explicit
 * candidates first, then (if `processMatch` is given) scan the host for a
 * matching listener. Returns the first URL that answers, or null.
 */
export async function detectService(input: DetectInput): Promise<DetectOutput> {
  const probePath = input.probePath ?? '/'
  const timeoutMs = input.timeoutMs ?? 1200
  const tried: string[] = []
  const seen = new Set<string>()

  const tryUrl = async (url: string, via: 'candidate' | 'scan'): Promise<DetectOutput | null> => {
    if (seen.has(url)) return null
    seen.add(url)
    tried.push(url)
    return (await probeUrl(url, probePath, timeoutMs)) ? { baseUrl: url, via, tried } : null
  }

  for (const c of input.candidates) {
    const url = normalizeCandidate(c)
    if (!url) continue
    const hit = await tryUrl(url, 'candidate')
    if (hit) return hit
  }

  if (input.processMatch) {
    const ports = await scanPorts(input.processMatch)
    for (const port of ports.slice(0, input.maxScan ?? 12)) {
      const hit = await tryUrl(`http://${LOOPBACK}:${port}`, 'scan')
      if (hit) return hit
    }
  }

  return { baseUrl: null, via: null, tried }
}
