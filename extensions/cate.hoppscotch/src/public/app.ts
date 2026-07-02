// Hoppscotch panel (connect-only). External script (CSP-safe). All fetch/iframe
// URLs are relative so they resolve under /ext/<routeToken>/ and tunnel through
// Cate's proxy.
//
// The shared ServiceConnection widget owns the connect / ready gating; this
// connects to a Hoppscotch instance the USER runs (docker AIO), persisted via
// the server's __hopp/upstream endpoint. Once connected it embeds the proxied
// app into the widget's content area, with a helper bar that shows (and copies)
// the built-in request-proxy URL — paste it into Hoppscotch's
// Settings → Interceptor → Proxy so API requests execute through the wrapper
// (loopback, no webview CORS limits).

import '../_kit/cate-kit.css'
import './style.css'
import { initTheme } from '../_kit/theme'
import { ServiceConnection, iconNode } from '../_kit/service-connection'

// This panel's public base path (`/ext/<routeToken>/`). Reported to the wrapper
// (it rewrites the app's root-absolute URLs against it) and the base for every
// fetch/iframe URL here.
const BASE = location.pathname.replace(/[^/]*$/, '')

interface Status {
  upstream: string | null
  reachable: boolean
  source: 'manual' | 'auto' | null
  workspaceRoot: string | null
  proxyPath: string
}

const ICON =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="M9 1.5 3.5 9H7l-1 5.5L11.5 7H8z" fill="none" stroke="currentColor" stroke-linejoin="round"/></svg>'

let lastStatus: Status | null = null

const conn = new ServiceConnection(document.getElementById('root')!, {
  serviceName: 'Hoppscotch',
  icon: ICON,
  repo: 'https://github.com/hoppscotch/hoppscotch',
  description:
    'Connect to a Hoppscotch instance you run yourself (this extension does not bundle Hoppscotch). ' +
    'The simplest way is the docker AIO image: ' +
    'docker run --rm -p 3000:3000 hoppscotch/hoppscotch — it is auto-detected on localhost:3000.',
  connect: {
    urlLabel: 'Hoppscotch URL',
    urlPlaceholder: 'http://localhost:3000',
    help:
      'Once connected, set Settings → Interceptor → Proxy inside Hoppscotch to the proxy URL shown ' +
      'above the app, so requests run through Cate (avoids browser CORS limits).',
    onSubmit: (v) => void submitUpstream(v.url),
    onDisconnect: () => void disconnect(),
  },
  onReady: (mount) => buildAppUI(mount),
})

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

/** Absolute URL of the wrapper's Proxyscotch-compatible endpoint — what the
 *  user pastes into Hoppscotch's proxy setting. Absolute because the app
 *  stores it as an opaque URL string. */
function proxyUrl(): string {
  return new URL(BASE + '__hopp/proxy', location.origin).href
}

async function fetchStatus(): Promise<Status> {
  const res = await fetch(BASE + '__hopp/status?base=' + encodeURIComponent(BASE))
  return (await res.json()) as Status
}

/** Apply a Status to the widget. With an upstream set we go ready and embed the
 *  iframe (even if currently unreachable, so the user sees the upstream's own
 *  error rather than a blank panel); with none we show the connect form. */
function applyStatus(s: Status): void {
  lastStatus = s
  if (s.upstream) {
    conn.setState({ kind: 'ready' })
    updateCopyTooltip()
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
    const res = await fetch(BASE + '__hopp/upstream', {
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
    await fetch(BASE + '__hopp/upstream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ upstream: null }),
    })
  } catch {
    /* best-effort; re-check below regardless */
  }
  conn.setState({ kind: 'needs-connection' })
}

// --- app UI (built once, into the widget's content area) ----------------------

let copyBtn: HTMLButtonElement | null = null

// A link/chain glyph for the floating copy-proxy-URL button.
const COPY_ICON =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor"/><path d="M10.5 5.5v-2A1.5 1.5 0 0 0 9 2H4a1.5 1.5 0 0 0-1.5 1.5v5A1.5 1.5 0 0 0 4 10h1.5" fill="none" stroke="currentColor"/></svg>'

function updateCopyTooltip(): void {
  if (copyBtn) {
    const src = lastStatus?.source === 'auto' ? ' (auto-detected)' : ''
    copyBtn.title =
      `Copy the request-proxy URL for Hoppscotch's Proxy interceptor\n` +
      `(Settings → Interceptor → Proxy: ${proxyUrl()})\n` +
      `Connected to ${lastStatus?.upstream || '?'}${src}`
  }
}

function buildAppUI(mount: HTMLElement): void {
  const wrap = el('div', 'hs-wrap')

  const frame = el('iframe', 'hs-frame') as HTMLIFrameElement
  frame.title = 'Hoppscotch'
  frame.referrerPolicy = 'no-referrer'
  // /index.html (not /) because the wrapper's shell owns the root path; the
  // upstream serves the SPA for it, and the wrapper rewrites its asset URLs.
  frame.src = BASE + 'index.html'

  copyBtn = el('button', 'cate-overlay-btn') as HTMLButtonElement
  copyBtn.type = 'button'
  const glyph = iconNode(COPY_ICON)
  if (glyph) copyBtn.appendChild(glyph)
  else copyBtn.textContent = '⧉'
  copyBtn.setAttribute('aria-label', 'Copy request-proxy URL')
  copyBtn.addEventListener('click', () => void copyProxyUrl())
  updateCopyTooltip()

  wrap.append(frame, copyBtn)
  mount.appendChild(wrap)

  cate?.panel.setTitle('Hoppscotch').catch(() => {})
}

async function copyProxyUrl(): Promise<void> {
  try {
    await navigator.clipboard.writeText(proxyUrl())
    await cate?.ui.notify('Proxy URL copied — paste into Hoppscotch Settings → Interceptor → Proxy.', 'info')
  } catch {
    await cate?.ui.notify('Could not copy to clipboard.', 'warn')
  }
}

// --- boot ----------------------------------------------------------------------

async function boot(): Promise<void> {
  await initTheme()
  await recheck()
}

void boot()
