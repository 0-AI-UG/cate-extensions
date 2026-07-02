// =============================================================================
// Pure config + URL helpers for the Hoppscotch wrapper (connect-only).
//
// This extension does NOT bundle Hoppscotch. The user runs their own instance
// (typically the docker AIO image); the wrapper (server.ts) reverse-proxies the
// Cate panel to it. These helpers resolve/normalize the upstream origin and
// validate the panel-reported public base path used by the URL rewriters.
//
// Everything here is pure so it unit-tests without a network or filesystem.
// =============================================================================

/** Hoppscotch's default self-host frontend port (docker AIO default). */
export const HOPPSCOTCH_DEFAULT_FRONTEND = 'http://localhost:3000'

/** Env var the user can set to preset the upstream Hoppscotch instance URL. */
export const UPSTREAM_ENV = 'HOPPSCOTCH_UPSTREAM'
/** Storage key (cate.storage, extension-scoped) holding the configured upstream. */
export const UPSTREAM_STORAGE_KEY = 'hoppscotch:upstream'

/** Wrapper-owned control prefix; everything else is proxied to the upstream.
 *  Kept in sync with the routes in server.ts and the panel's fetches. */
export const CONTROL_PREFIX = '/__hopp'

/**
 * Normalize a user-provided upstream URL into an origin we can proxy to, or
 * null if unusable. Accepts bare host:port, strips trailing slashes/paths,
 * defaults the scheme to http (the docker AIO binds loopback over http).
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
  // Origin only — Hoppscotch's own router owns the path space.
  return u.origin
}

/**
 * Resolve the upstream Hoppscotch origin from (in priority order): an explicit
 * stored value, then the HOPPSCOTCH_UPSTREAM env var. Returns null if neither
 * is set (the panel then prompts / auto-detects).
 */
export function resolveUpstream(opts: {
  stored?: unknown
  env?: string | undefined
}): string | null {
  return normalizeUpstream(opts.stored) ?? normalizeUpstream(opts.env)
}

/**
 * Validate + normalize the public base path the PANEL reports (its
 * `location.pathname` directory, e.g. `/ext/a1b2c3/`). It is client-supplied
 * and spliced into rewritten upstream content, so it is strictly shape-checked:
 * absolute, trailing slash, conservative path characters, no traversal.
 * Returns null when unusable.
 */
export function normalizePublicBase(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s.startsWith('/') || !s.endsWith('/')) return null
  if (s.length > 256) return null
  if (!/^\/(?:[A-Za-z0-9._-]+\/)*$/.test(s)) return null
  if (s.includes('..')) return null
  return s
}
