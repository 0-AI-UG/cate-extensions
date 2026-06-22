// =============================================================================
// Pure Sourcebot helpers — no Node/DOM imports, so they unit-test cleanly and
// are shared by the server (response normalization, URL hygiene) and (by intent)
// mirror what the panel renders.
//
// Sourcebot's POST /api/search response is Zoekt-shaped:
//   { stats, files: [ { fileName: { text }, repository, webUrl, language,
//                       chunks: [ { content?: {text} | string,
//                                   contentStart: { lineNumber }, matchRanges } ] } ] }
// The shape has drifted across Sourcebot versions (content as a string vs.
// { text }, chunk vs. line forms), so normalizeSearchResponse is defensive: it
// extracts what it can and never throws on an unexpected field.
// =============================================================================

/** One flattened search hit the panel renders and that maps to editor.openFile. */
export interface SearchHit {
  /** Repository name as Sourcebot reports it (display only). */
  repository: string
  /** File path within the repository (what we hand to editor.openFile). */
  path: string
  /** 1-based line number of the first match in this chunk, or 1 if unknown. */
  line: number
  /** The snippet text shown under the hit. */
  snippet: string
  /** Sourcebot's own web URL for this file, if present (used by "open in Sourcebot"). */
  webUrl?: string
  /** Language label, if Sourcebot provided one. */
  language?: string
}

export interface NormalizedSearch {
  hits: SearchHit[]
  /** Total match count Sourcebot reported, if available. */
  totalMatches: number | null
  /** True when Sourcebot signalled the result set was truncated. */
  truncated: boolean
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/** A chunk's text can be `content.text`, a bare `content` string, or `lines[]`. */
function chunkText(chunk: Record<string, unknown>): string {
  const content = chunk.content
  if (typeof content === 'string') return content
  if (content && typeof content === 'object') {
    const t = asString((content as Record<string, unknown>).text)
    if (t != null) return t
  }
  // Older/alternate shape: an array of line objects with `.content` or `.text`.
  const lines = chunk.lines
  if (Array.isArray(lines)) {
    return lines
      .map((l) => {
        if (typeof l === 'string') return l
        if (l && typeof l === 'object') {
          const o = l as Record<string, unknown>
          return asString(o.content) ?? asString(o.text) ?? ''
        }
        return ''
      })
      .join('\n')
  }
  return ''
}

/** The 1-based first line of a chunk, tolerant of the field having moved. */
function chunkStartLine(chunk: Record<string, unknown>): number {
  const probe = (v: unknown): number | undefined => {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v)
    if (v && typeof v === 'object') {
      const ln = (v as Record<string, unknown>).lineNumber
      if (typeof ln === 'number' && Number.isFinite(ln) && ln > 0) return Math.floor(ln)
    }
    return undefined
  }
  // Prefer the first match range's line, then the chunk's declared start.
  const ranges = chunk.matchRanges
  if (Array.isArray(ranges) && ranges.length > 0) {
    const r = ranges[0]
    if (r && typeof r === 'object') {
      const start = (r as Record<string, unknown>).start
      const fromStart = probe(start)
      if (fromStart != null) return fromStart
    }
  }
  return probe(chunk.contentStart) ?? probe(chunk.startLineNumber) ?? probe(chunk.lineNumber) ?? 1
}

/** A file entry's path: `fileName.text`, a bare `fileName` string, or `path`. */
function filePath(file: Record<string, unknown>): string | undefined {
  const fn = file.fileName
  if (typeof fn === 'string') return fn
  if (fn && typeof fn === 'object') {
    const t = asString((fn as Record<string, unknown>).text)
    if (t != null) return t
  }
  return asString(file.path) ?? asString(file.fileUrl)
}

/**
 * Normalize an untrusted /api/search response into flat hits. Never throws:
 * unknown shapes yield an empty hit list rather than an error.
 */
export function normalizeSearchResponse(parsed: unknown): NormalizedSearch {
  const empty: NormalizedSearch = { hits: [], totalMatches: null, truncated: false }
  if (!parsed || typeof parsed !== 'object') return empty
  const root = parsed as Record<string, unknown>

  const stats = (root.stats && typeof root.stats === 'object'
    ? (root.stats as Record<string, unknown>)
    : {}) as Record<string, unknown>
  const totalMatches =
    typeof stats.totalMatchCount === 'number'
      ? stats.totalMatchCount
      : typeof stats.actualMatchCount === 'number'
        ? stats.actualMatchCount
        : null
  // Sourcebot signals an incomplete result set a few ways across versions.
  const truncated = root.isSearchExhaustive === false || stats.isExhaustive === false

  const files = Array.isArray(root.files) ? root.files : []
  const hits: SearchHit[] = []

  for (const raw of files) {
    if (!raw || typeof raw !== 'object') continue
    const file = raw as Record<string, unknown>
    const path = filePath(file)
    if (!path) continue
    const repository = asString(file.repository) ?? asString(file.repositoryId) ?? ''
    const webUrl = asString(file.webUrl) ?? asString(file.url)
    const language = asString(file.language)

    const chunks = Array.isArray(file.chunks) ? file.chunks : []
    if (chunks.length === 0) {
      // A file match with no per-chunk detail still opens at line 1.
      hits.push({ repository, path, line: 1, snippet: '', webUrl, language })
      continue
    }
    for (const c of chunks) {
      if (!c || typeof c !== 'object') continue
      const chunk = c as Record<string, unknown>
      hits.push({
        repository,
        path,
        line: chunkStartLine(chunk),
        snippet: chunkText(chunk).replace(/\n+$/, ''),
        webUrl,
        language,
      })
    }
  }

  return { hits, totalMatches, truncated: Boolean(truncated) }
}

/**
 * Normalize a user-entered Sourcebot base URL: trim, drop a trailing slash,
 * and reject anything that isn't http(s). Returns null when unusable.
 */
export function normalizeBaseUrl(raw: unknown): string | null {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (!s) return null
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  // Keep an explicit path prefix (some users reverse-proxy Sourcebot under a
  // subpath) but strip a bare trailing slash for clean joining.
  const out = u.origin + u.pathname.replace(/\/+$/, '')
  return out
}

/**
 * Join a normalized base URL with an upstream path (which always begins "/").
 * Tolerates the base carrying a subpath prefix.
 */
export function joinUrl(base: string, upstreamPath: string): string {
  const b = base.replace(/\/+$/, '')
  const p = upstreamPath.startsWith('/') ? upstreamPath : '/' + upstreamPath
  return b + p
}

/**
 * Clamp a requested match count into a sane range so a panel can't ask the
 * upstream for an unbounded result set.
 */
export function clampMatches(n: unknown, fallback = 50, max = 200): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : fallback
  return Math.min(Math.max(v, 1), max)
}
