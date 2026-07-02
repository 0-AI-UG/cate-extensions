// Datasette panel. External script (CSP-safe, no inline JS). It:
//   - themes the chrome from cate.theme.get() via the shared kit
//   - asks the wrapper to start Datasette (reporting this panel's public base
//     path, which the wrapper bakes into Datasette's base_url), polls
//     /__datasette/status, and drives the shared ServiceConnection widget
//   - on ready, embeds the proxied explorer in an iframe with a small bar
//     showing the discovered databases and a Rescan action
//
// All fetch/iframe URLs are relative so they resolve under /ext/<routeToken>/
// and tunnel through Cate's proxy, which injects the bearer; the page never
// holds a token.

import '../_kit/cate-kit.css'
import './style.css'
import { initTheme } from '../_kit/theme'
import { ServiceConnection, iconNode } from '../_kit/service-connection'

// This panel's public base path (`/ext/<routeToken>/`). Reported to the wrapper
// so Datasette emits URLs that resolve through Cate's proxy; also the base for
// every fetch/iframe URL here.
const BASE = location.pathname.replace(/[^/]*$/, '')

// Datasette is mounted under this sub-path by the wrapper (kept in sync with
// DATASETTE_SUBPATH in src/datasette.ts); the shell itself lives at "/".
const DB_PATH = 'db/'
const PANEL_STATE_KEY = 'shell'

interface WrapperStatus {
  status: 'idle' | 'starting' | 'ready' | 'error'
  via?: string | null
  error?: string | null
  workspaceRoot?: string | null
  dbCount?: number
  dbNames?: string[]
  stderrTail?: string[]
}

const ICON =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><ellipse cx="8" cy="3.5" rx="5" ry="2" fill="none" stroke="currentColor"/><path d="M3 3.5v4.5c0 1.1 2.24 2 5 2s5-.9 5-2V3.5" fill="none" stroke="currentColor"/><path d="M3 8v4.5c0 1.1 2.24 2 5 2s5-.9 5-2V8" fill="none" stroke="currentColor"/></svg>'

let lastStatus: WrapperStatus | null = null

const conn = new ServiceConnection(document.getElementById('root')!, {
  serviceName: 'Datasette',
  icon: ICON,
  repo: 'https://github.com/simonw/datasette',
  description:
    'A local Datasette is launched over the SQLite files found in this workspace and embedded here. ' +
    'It runs from a datasette on your PATH, or via uvx / pipx (the first run may download it).',
  onRetry: () => void start(),
  onReady: (mount) => buildExplorerUI(mount),
})

let notifiedError = false
let pollTimer: ReturnType<typeof setTimeout> | null = null
// Numbered poll chains: each control() starts a new chain and orphans the old
// one, so a stale in-flight status fetch can never repaint over a newer state.
let pollGen = 0

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

function rememberStatus(status: string): void {
  try {
    void cate?.storage.panel.set(PANEL_STATE_KEY, { status, at: Date.now() })
  } catch {
    /* storage is best-effort UI state */
  }
}

function showError(s: WrapperStatus): void {
  conn.setState({
    kind: 'error',
    message:
      s.error ||
      'No Datasette install was found. Install it (uv tool install datasette / pipx install datasette / pip install datasette) or set DATASETTE_CMD.',
    detail: s.stderrTail && s.stderrTail.length ? s.stderrTail.join('\n') : undefined,
    canRetry: true,
  })
  rememberStatus('error')
  if (!notifiedError) {
    notifiedError = true
    cate?.ui.notify('Datasette failed to start. See the panel for details.', 'error').catch(() => {})
  }
}

function showStarting(s: WrapperStatus): void {
  conn.setState({
    kind: 'provisioning',
    message: s.via
      ? `Launching via ${s.via}. First run may download Datasette.`
      : 'Resolving a Datasette install on this machine…',
    log: s.stderrTail && s.stderrTail.length ? s.stderrTail.join('\n') : undefined,
  })
}

async function fetchStatus(): Promise<WrapperStatus> {
  const res = await fetch(BASE + '__datasette/status', { headers: { accept: 'application/json' } })
  return (await res.json()) as WrapperStatus
}

function applyStatus(s: WrapperStatus): boolean {
  lastStatus = s
  if (s.status === 'ready') {
    conn.setState({ kind: 'ready' })
    rememberStatus('ready')
    updateRescanTooltip()
    updateEmptyNotice()
    return true
  }
  if (s.status === 'error') {
    showError(s)
    return true
  }
  showStarting(s)
  return false
}

async function poll(gen: number): Promise<void> {
  let s: WrapperStatus
  try {
    s = await fetchStatus()
  } catch (err) {
    if (gen !== pollGen) return
    showError({ status: 'error', error: 'Lost contact with the wrapper: ' + String(err) })
    return
  }
  if (gen !== pollGen) return // a newer chain owns the UI now
  if (!applyStatus(s)) {
    pollTimer = setTimeout(() => void poll(gen), 600)
  }
}

/** Start a fresh poll chain (cancelling any previous one); returns its id. */
function startPolling(delayMs: number): number {
  const gen = ++pollGen
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = setTimeout(() => void poll(gen), delayMs)
  return gen
}

async function control(endpoint: 'start' | 'restart'): Promise<void> {
  notifiedError = false
  conn.setState({ kind: 'provisioning' })
  rememberStatus('starting')
  // The start request blocks until Datasette is up (or failed) — poll while it
  // is in flight so the card shows live status and the captured install log
  // (a first uvx/pipx run downloads Datasette) instead of a silent spinner.
  const gen = startPolling(400)
  try {
    const res = await fetch(BASE + '__datasette/' + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicBase: BASE }),
    })
    const s = (await res.json()) as WrapperStatus
    if (gen !== pollGen) return // a newer control() superseded this one
    pollGen++ // retire the in-flight chain; this response is authoritative
    if (pollTimer) clearTimeout(pollTimer)
    if (!applyStatus(s)) startPolling(600) // still starting (rare) — keep watching
  } catch {
    /* leave the poll chain running; it will surface the failure */
  }
}

function start(): Promise<void> {
  return control('start')
}

// --- explorer UI (built once, into the widget's content area) -----------------

let frame: HTMLIFrameElement | null = null
let rescanBtn: HTMLButtonElement | null = null
let emptyNote: HTMLElement | null = null

// A circular-arrows refresh glyph for the floating Rescan button.
const RESCAN_ICON =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M13.7 1.8v2.8h-2.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'

function dbSummary(s: WrapperStatus | null): string {
  const count = s?.dbCount ?? 0
  if (count === 0) return 'No SQLite files found — showing an empty in-memory database'
  const names = (s?.dbNames || []).slice(0, 4).join(', ')
  const more = count > 4 ? `, +${count - 4} more` : ''
  return `${count} database${count === 1 ? '' : 's'}: ${names}${more}`
}

function updateRescanTooltip(): void {
  if (rescanBtn) {
    rescanBtn.title = `Rescan the workspace for SQLite files\n${dbSummary(lastStatus)}`
  }
}

/** A zero-databases workspace still gets a working Datasette (in-memory), but
 *  an unexplained empty UI reads as broken — show a banner saying why, and
 *  what to do about it. Hidden as soon as a (re)scan finds databases. */
function updateEmptyNotice(): void {
  if (emptyNote) emptyNote.hidden = (lastStatus?.dbCount ?? 0) > 0
}

function buildExplorerUI(mount: HTMLElement): void {
  const wrap = el('div', 'dst-wrap')

  frame = el('iframe', 'dst-frame') as HTMLIFrameElement
  frame.title = 'Datasette'
  frame.referrerPolicy = 'no-referrer'
  frame.src = BASE + DB_PATH

  rescanBtn = el('button', 'cate-overlay-btn') as HTMLButtonElement
  rescanBtn.type = 'button'
  const glyph = iconNode(RESCAN_ICON)
  if (glyph) rescanBtn.appendChild(glyph)
  else rescanBtn.textContent = '↻'
  rescanBtn.setAttribute('aria-label', 'Rescan workspace for SQLite files')
  rescanBtn.addEventListener('click', () => void rescanAndReload())
  updateRescanTooltip()

  emptyNote = el(
    'div',
    'dst-empty',
    'No SQLite files found in this workspace — Datasette is running on an empty ' +
      'in-memory database. Add a .db / .sqlite file and hit Rescan.',
  )
  emptyNote.hidden = true

  wrap.append(frame, emptyNote, rescanBtn)
  mount.appendChild(wrap)

  cate?.panel.setTitle('Datasette').catch(() => {})
}

async function rescanAndReload(): Promise<void> {
  if (rescanBtn) rescanBtn.disabled = true
  try {
    await control('restart')
  } finally {
    if (rescanBtn) rescanBtn.disabled = false
  }
  // control() lands back in ready (or error); on ready, reload the explorer so
  // it reflects the fresh database set.
  if (frame && lastStatus?.status === 'ready') {
    frame.src = BASE + DB_PATH
    updateRescanTooltip()
  }
}

async function boot(): Promise<void> {
  await initTheme()
  void start()
}

void boot()
