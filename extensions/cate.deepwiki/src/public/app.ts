// DeepWiki panel (connect-only). External script (CSP-safe). All fetch/iframe
// URLs are relative so they resolve under /ext/<routeToken>/ and tunnel through
// Cate's proxy.
//
// The shared ServiceConnection widget owns the connect / ready gating; this
// connects to a DeepWiki instance the USER runs (docker compose), persisted via
// the server's ./api/upstream endpoint. Once connected it embeds the proxied
// DeepWiki UI into the widget's content area, with:
//   - code-reference click interception routed to cate.editor.openFile, and
//   - a small "Copy .env" helper bar (the .env derived from Cate's provider).

import '../_kit/cate-kit.css'
import './style.css'
import { initTheme } from '../_kit/theme'
import { ServiceConnection, iconNode } from '../_kit/service-connection'

// Self-contained copy of the parser used by the server, so the panel can decide
// locally whether a clicked link is a workspace file reference. Kept in sync
// with src/config.ts::parseCodeRef.
function parseCodeRef(href: unknown): { path: string; line?: number } | null {
  if (typeof href !== 'string') return null
  let s = href.trim()
  if (!s) return null
  if (s.toLowerCase().startsWith('cate-open:')) {
    s = s.slice('cate-open:'.length)
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(mailto|tel|javascript):/i.test(s)) {
    return null
  }
  if (s.startsWith('#')) return null
  let line: number | undefined
  const q = s.indexOf('?')
  if (q !== -1) {
    const query = new URLSearchParams(s.slice(q + 1))
    const l = query.get('line')
    if (l && /^\d+$/.test(l)) line = Number(l)
    s = s.slice(0, q)
  }
  const hashMatch = s.match(/#L?(\d+)$/)
  if (hashMatch) {
    line = line ?? Number(hashMatch[1])
    s = s.slice(0, s.length - hashMatch[0].length)
  } else {
    const colonMatch = s.match(/:(\d+)$/)
    if (colonMatch && !/^[a-zA-Z]:[\\/]/.test(s)) {
      line = line ?? Number(colonMatch[1])
      s = s.slice(0, s.length - colonMatch[0].length)
    }
  }
  s = s.replace(/^\/+/, '')
  if (!s || s.includes('..')) return null
  if (!/\.[a-z0-9]+$/i.test(s) && !s.includes('/')) return null
  return line != null ? { path: s, line } : { path: s }
}

const BASE = location.pathname.replace(/[^/]*$/, '')

interface Status {
  upstream: string | null
  reachable: boolean
  workspaceRoot: string | null
  cateProviders: string[]
  canReuseCateProvider: boolean
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

// --- the connection widget ---------------------------------------------------

let lastStatus: Status | null = null

const ICON =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="M2 3.5A1.5 1.5 0 0 1 3.5 2H7v11H3.5A1.5 1.5 0 0 1 2 11.5z" fill="none" stroke="currentColor" stroke-linejoin="round"/><path d="M14 3.5A1.5 1.5 0 0 0 12.5 2H9v11h3.5A1.5 1.5 0 0 0 14 11.5z" fill="none" stroke="currentColor" stroke-linejoin="round"/></svg>'

const conn = new ServiceConnection(document.getElementById('root')!, {
  serviceName: 'DeepWiki',
  icon: ICON,
  repo: 'https://github.com/AsyncFuncAI/deepwiki-open',
  description:
    'Connect to a DeepWiki-Open instance you run yourself (this extension does not bundle or start DeepWiki). The simplest way is `docker compose up` in a clone of deepwiki-open, which serves the frontend on http://localhost:3000.',
  connect: {
    urlLabel: 'DeepWiki URL',
    urlPlaceholder: 'http://localhost:3000',
    help: 'DeepWiki reads its provider keys from its own .env. Once connected, a "Copy .env" helper derived from Cate\'s configured provider appears above the wiki.',
    onSubmit: (v) => void submitUpstream(v.url),
    onDisconnect: () => void disconnect(),
  },
  onReady: (mount) => buildWikiUI(mount),
})

async function fetchStatus(): Promise<Status> {
  const res = await fetch(BASE + 'api/status')
  return (await res.json()) as Status
}

/** Apply a Status to the widget. With an upstream set we go ready and embed the
 *  iframe (even if currently unreachable, so the user sees the upstream's own
 *  error rather than a blank panel); with none we show the connect form. */
function applyStatus(s: Status): void {
  lastStatus = s
  if (s.upstream) {
    conn.setState({ kind: 'ready' })
  } else {
    conn.setState({ kind: 'needs-connection' })
  }
}

async function recheck(): Promise<void> {
  conn.setState({ kind: 'connecting' })
  try {
    applyStatus(await fetchStatus())
  } catch (err) {
    conn.setState({
      kind: 'error',
      message: 'Cannot reach the extension server.',
      detail: String(err),
      canRetry: true,
    })
  }
}

async function submitUpstream(url: string): Promise<void> {
  conn.setState({ kind: 'connecting', message: 'Connecting…' })
  try {
    const res = await fetch(BASE + 'api/upstream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ upstream: url }),
    })
    const json = (await res.json()) as { ok?: boolean; error?: string }
    if (!json.ok) {
      conn.setState({ kind: 'needs-connection', baseUrl: url, message: 'Invalid URL: ' + (json.error || '') })
      return
    }
    applyStatus(await fetchStatus())
  } catch (err) {
    conn.setState({
      kind: 'error',
      message: 'Failed to connect.',
      detail: String(err),
      canRetry: true,
    })
  }
}

async function disconnect(): Promise<void> {
  conn.setState({ kind: 'connecting', message: 'Disconnecting…' })
  try {
    await fetch(BASE + 'api/upstream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ upstream: null }),
    })
  } catch {
    /* best-effort; re-check below regardless */
  }
  conn.setState({ kind: 'needs-connection' })
}

// --- wiki UI (built once, into the widget's content area) --------------------

let wikiFrame!: HTMLIFrameElement

// A file/download glyph for the floating copy-.env button.
const ENV_ICON =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="M4 1.5h5L12.5 5v9A1.5 1.5 0 0 1 11 15.5H4A1.5 1.5 0 0 1 2.5 14V3A1.5 1.5 0 0 1 4 1.5z" fill="none" stroke="currentColor" stroke-linejoin="round"/><path d="M9 1.5V5h3.5" fill="none" stroke="currentColor" stroke-linejoin="round"/></svg>'

function buildWikiUI(mount: HTMLElement): void {
  const wrap = el('div', 'dw-wrap')

  wikiFrame = el('iframe', 'dw-wiki') as HTMLIFrameElement
  wikiFrame.title = 'DeepWiki'
  wikiFrame.referrerPolicy = 'no-referrer'
  // Load our own origin root, which the server reverse-proxies to upstream.
  wikiFrame.src = BASE

  // Floating "Copy .env" control (only meaningful if Cate has a reusable
  // provider — copyEnv() explains itself via cate.ui.notify either way).
  const providers = lastStatus?.cateProviders ?? []
  const copyBtn = el('button', 'cate-overlay-btn') as HTMLButtonElement
  copyBtn.type = 'button'
  const glyph = iconNode(ENV_ICON)
  if (glyph) copyBtn.appendChild(glyph)
  else copyBtn.textContent = '⧉'
  copyBtn.setAttribute('aria-label', 'Copy .env for DeepWiki')
  copyBtn.title =
    "Copy a .env derived from Cate's provider keys to paste into your DeepWiki instance\n" +
    (providers.length ? `Cate providers: ${providers.join(', ')}` : 'No Cate provider configured')
  copyBtn.addEventListener('click', () => void copyEnv())

  wrap.append(wikiFrame, copyBtn)
  mount.appendChild(wrap)

  attachIframeGlue()
}

async function copyEnv(): Promise<void> {
  let dotenv = ''
  try {
    const res = await fetch(BASE + 'api/env')
    dotenv = ((await res.json()) as { dotenv?: string }).dotenv || ''
  } catch {
    /* fall through to the empty-clipboard guard below */
  }
  if (!dotenv) {
    await cate?.ui.notify('No reusable provider key found in Cate (Settings → Providers).', 'warn')
    return
  }
  try {
    await navigator.clipboard.writeText(dotenv)
    await cate?.ui.notify('DeepWiki .env copied to clipboard', 'info')
  } catch {
    await cate?.ui.notify('Could not copy to clipboard.', 'warn')
  }
}

// --- code-reference glue -----------------------------------------------------

// Intercept clicks inside the proxied DeepWiki UI (same-origin, so we can reach
// its document) and route code references to Cate's editor. Re-attaches on each
// navigation. If the document is ever cross-origin/inaccessible, we silently
// fall back to normal in-iframe navigation.
function attachIframeGlue(): void {
  wikiFrame.addEventListener('load', () => {
    let doc: Document | null = null
    try {
      doc = wikiFrame.contentDocument
    } catch {
      doc = null // cross-origin; can't instrument
    }
    if (!doc) return
    doc.addEventListener(
      'click',
      (e) => {
        const target = e.target as HTMLElement | null
        const anchor = target?.closest?.('a') as HTMLAnchorElement | null
        if (!anchor) return
        // Prefer the raw attribute over the resolved .href (which would be
        // absolutized against our proxy origin).
        const rawHref = anchor.getAttribute('href') || ''
        const ref = parseCodeRef(rawHref)
        if (!ref) return
        e.preventDefault()
        e.stopPropagation()
        void openInEditor(ref)
      },
      true,
    )
  })
}

// postMessage fallback: a future DeepWiki patch (or a userscript) can post
// { type: 'cate-open-file', path, line } and we'll honor it.
function attachMessageGlue(): void {
  window.addEventListener('message', (e) => {
    const data = e.data as { type?: string; path?: unknown; line?: unknown } | null
    if (!data || data.type !== 'cate-open-file') return
    const ref = parseCodeRef(typeof data.path === 'string' ? data.path : '')
    if (!ref) return
    if (typeof data.line === 'number') ref.line = data.line
    void openInEditor(ref)
  })
}

async function openInEditor(ref: { path: string; line?: number }): Promise<void> {
  if (!window.cate) return
  try {
    await cate.editor.openFile(ref.path, ref.line != null ? { line: ref.line } : undefined)
    await cate.ui.notify(`Opened ${ref.path}${ref.line ? ':' + ref.line : ''}`, 'info')
  } catch (err) {
    await cate.ui.notify('Could not open ' + ref.path + ': ' + String(err), 'warn')
  }
}

// --- boot --------------------------------------------------------------------

async function boot(): Promise<void> {
  await initTheme()
  attachMessageGlue()
  await recheck()
}

void boot()
