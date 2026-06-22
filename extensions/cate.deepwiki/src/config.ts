// =============================================================================
// Pure config + URL helpers for the DeepWiki wrapper (connect-only).
//
// This extension does NOT bundle DeepWiki. The user runs their own DeepWiki-Open
// instance; the launcher (server.ts) reverse-proxies the Cate panel to it. These
// helpers resolve/normalize the upstream origin and parse DeepWiki code-reference
// links into workspace-relative file refs.
//
// Everything here is pure so it unit-tests without a network or filesystem.
// =============================================================================

/** DeepWiki-Open's default frontend port (docker-compose / dev default). */
export const DEEPWIKI_DEFAULT_FRONTEND = 'http://localhost:3000'

/** Env var the user can set to preset the upstream DeepWiki instance URL. */
export const UPSTREAM_ENV = 'DEEPWIKI_UPSTREAM'
/** Storage key (cate.storage, extension-scoped) holding the configured upstream. */
export const UPSTREAM_STORAGE_KEY = 'deepwiki:upstream'

/**
 * Normalize a user-provided upstream URL into an origin we can proxy to, or
 * null if unusable. Accepts bare host:port, strips trailing slashes/paths,
 * defaults the scheme to http (DeepWiki binds loopback over http by default).
 */
export function normalizeUpstream(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let s = raw.trim()
  if (!s) return null
  // Reject any explicit non-http(s) URL scheme (ftp://, file://, …) up front so
  // we don't prepend http:// and mis-parse it (e.g. "ftp://host" -> host "ftp").
  // A "scheme:" is only treated as such when followed by a slash or non-digit,
  // so a bare "localhost:3000" (port, not scheme) still passes through.
  if (/^[a-z][a-z0-9+.-]*:(\/|[^0-9])/i.test(s) && !/^https?:\/\//i.test(s)) return null
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  // Origin only — DeepWiki's own router owns the path space.
  return u.origin
}

/**
 * Resolve the upstream DeepWiki origin from (in priority order): an explicit
 * stored value, then the DEEPWIKI_UPSTREAM env var. Returns null if neither is
 * set (the panel then prompts the user to configure one).
 */
export function resolveUpstream(opts: {
  stored?: unknown
  env?: string | undefined
}): string | null {
  return normalizeUpstream(opts.stored) ?? normalizeUpstream(opts.env)
}

/**
 * Parse a DeepWiki code-reference target into a workspace-relative path + line.
 *
 * DeepWiki renders source citations as links/anchors that encode a repo-relative
 * path and (optionally) a line. We accept the common shapes so the panel can
 * route a click to `cate.editor.openFile(path, { line })` instead of navigating:
 *
 *   src/foo/bar.ts#L42         -> { path: 'src/foo/bar.ts', line: 42 }
 *   /src/foo/bar.ts:42         -> { path: 'src/foo/bar.ts', line: 42 }
 *   cate-open:src/x.ts?line=10 -> { path: 'src/x.ts', line: 10 }
 *   src/x.ts                   -> { path: 'src/x.ts' }
 *
 * Returns null for anything that isn't a plausible repo-relative file ref
 * (absolute URLs, mailto:, in-page #anchors, etc.).
 */
export function parseCodeRef(href: unknown): { path: string; line?: number } | null {
  if (typeof href !== 'string') return null
  let s = href.trim()
  if (!s) return null

  // Our own explicit scheme, if DeepWiki (or a future patch) emits it.
  if (s.toLowerCase().startsWith('cate-open:')) {
    s = s.slice('cate-open:'.length)
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(mailto|tel|javascript):/i.test(s)) {
    // Any real URL scheme (http://, https://, vscode://, mailto:, …) is not a
    // workspace file ref — let the webview handle it normally.
    return null
  }

  // Pure in-page anchor.
  if (s.startsWith('#')) return null

  let line: number | undefined

  // ?line=NN query form.
  const q = s.indexOf('?')
  if (q !== -1) {
    const query = new URLSearchParams(s.slice(q + 1))
    const l = query.get('line')
    if (l && /^\d+$/.test(l)) line = Number(l)
    s = s.slice(0, q)
  }

  // #LNN or #NN fragment form.
  const hashMatch = s.match(/#L?(\d+)$/)
  if (hashMatch) {
    line = line ?? Number(hashMatch[1])
    s = s.slice(0, s.length - hashMatch[0].length)
  } else {
    // path:NN suffix form (avoid eating a Windows drive letter like C:).
    const colonMatch = s.match(/:(\d+)$/)
    if (colonMatch && !/^[a-zA-Z]:[\\/]/.test(s)) {
      line = line ?? Number(colonMatch[1])
      s = s.slice(0, s.length - colonMatch[0].length)
    }
  }

  // Strip a single leading slash so it's workspace-relative (Cate confines
  // openFile to the workspace root and rejects absolute escapes).
  s = s.replace(/^\/+/, '')
  if (!s || s.includes('..')) return null

  // Must look like a file (has an extension or a path separator).
  if (!/\.[a-z0-9]+$/i.test(s) && !s.includes('/')) return null

  return line != null ? { path: s, line } : { path: s }
}
