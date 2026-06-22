// MCPHub panel shell. External script (CSP-safe, no inline JS). It:
//   - themes the loader/error overlay from cate.theme.get()
//   - sets the panel title via cate.panel.setTitle
//   - asks the wrapper to start MCPHub, polls /__mcphub/status, and on "ready"
//     embeds the proxied dashboard in an iframe
//   - surfaces failures with cate.ui.notify and an inline retry
//   - remembers the panel's last status via cate.storage.panel so a reopened
//     panel can hint what it was doing
//
// All fetch/iframe URLs are relative so they tunnel through Cate's proxy, which
// injects the bearer; the page never holds a token.

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T
}

const overlay = byId<HTMLElement>('overlay')
const spinner = byId<HTMLElement>('spinner')
const titleEl = byId<HTMLElement>('title')
const detailEl = byId<HTMLElement>('detail')
const logsEl = byId<HTMLPreElement>('logs')
const retryBtn = byId<HTMLButtonElement>('retry')
const frame = byId<HTMLIFrameElement>('frame')

// --- theming ----------------------------------------------------------------

/** Map Cate's theme palette onto the overlay's CSS variables. The dashboard
 *  itself is MCPHub's own UI (rendered in the iframe); we can only theme the
 *  wrapper chrome, so we keep it minimal and matched to Cate's app colors. */
function applyTheme(theme: CateHostTheme): void {
  const app = theme.app || {}
  const pick = (...keys: string[]): string | null => {
    for (const k of keys) if (app[k]) return app[k]
    return null
  }
  const root = document.documentElement.style
  const bg = pick('app-bg', 'editor-bg', 'bg', 'background')
  const fg = pick('app-fg', 'editor-fg', 'fg', 'foreground', 'text')
  const accent = pick('accent', 'focus', 'link', 'primary')
  if (bg) root.setProperty('--mh-bg', bg)
  if (fg) root.setProperty('--mh-fg', fg)
  if (accent) root.setProperty('--mh-accent', accent)
  document.documentElement.dataset.theme = theme.type
}

// --- panel state ------------------------------------------------------------

const PANEL_STATE_KEY = 'shell'

async function rememberStatus(status: string): Promise<void> {
  try {
    await cate.storage.panel.set(PANEL_STATE_KEY, { status, at: Date.now() })
  } catch {
    /* storage is best-effort UI state */
  }
}

// --- status flow ------------------------------------------------------------

interface WrapperStatus {
  status: 'idle' | 'starting' | 'ready' | 'error'
  via?: string | null
  error?: string | null
  stderrTail?: string[]
}

let notifiedError = false
let pollTimer: ReturnType<typeof setTimeout> | null = null

function showOverlay(): void {
  overlay.hidden = false
  frame.hidden = true
}

function showFrame(): void {
  overlay.hidden = true
  frame.hidden = false
}

function setError(s: WrapperStatus): void {
  spinner.hidden = true
  titleEl.textContent = 'MCPHub could not start'
  detailEl.textContent =
    s.error ||
    'No MCPHub install was found. Install it (npm i -g @samanhappy/mcphub) or set MCPHUB_CMD.'
  if (s.stderrTail && s.stderrTail.length) {
    logsEl.hidden = false
    logsEl.textContent = s.stderrTail.join('\n')
  }
  retryBtn.hidden = false
  void rememberStatus('error')
  if (!notifiedError) {
    notifiedError = true
    cate.ui.notify('MCPHub failed to start. See the panel for details.', 'error').catch(() => {})
  }
}

function setStarting(s: WrapperStatus): void {
  spinner.hidden = false
  titleEl.textContent = 'Starting MCPHub…'
  detailEl.textContent = s.via
    ? `Launching via ${s.via}. First run may download MCPHub.`
    : 'Resolving a MCPHub install on this machine.'
  retryBtn.hidden = true
  logsEl.hidden = true
}

// MCPHub is mounted under this base path by the wrapper (kept in sync with
// MCPHUB_BASE_PATH in src/mcphub.ts); the shell itself lives at "/".
const DASH_PATH = '/__mcphub/dash'

function embedDashboard(): void {
  showFrame()
  // Point the iframe at the proxied, base-path-mounted MCPHub dashboard.
  if (!frame.src || frame.src.endsWith('about:blank') || !frame.src.includes(DASH_PATH)) {
    frame.src = DASH_PATH
  }
  void rememberStatus('ready')
  cate.panel.setTitle('MCPHub').catch(() => {})
  cate.ui.notify('MCPHub is ready.', 'info').catch(() => {})
}

async function fetchStatus(): Promise<WrapperStatus> {
  const res = await fetch('/__mcphub/status', { headers: { accept: 'application/json' } })
  return (await res.json()) as WrapperStatus
}

async function poll(): Promise<void> {
  let s: WrapperStatus
  try {
    s = await fetchStatus()
  } catch (err) {
    setError({ status: 'error', error: 'Lost contact with the wrapper: ' + String(err) })
    return
  }

  if (s.status === 'ready') {
    embedDashboard()
    return
  }
  if (s.status === 'error') {
    showOverlay()
    setError(s)
    return
  }
  // idle or starting: keep polling.
  showOverlay()
  setStarting(s)
  pollTimer = setTimeout(poll, 600)
}

async function start(): Promise<void> {
  notifiedError = false
  showOverlay()
  setStarting({ status: 'starting' })
  await rememberStatus('starting')
  try {
    await fetch('/__mcphub/start', { method: 'POST' })
  } catch {
    /* poll() will report the failure */
  }
  if (pollTimer) clearTimeout(pollTimer)
  void poll()
}

retryBtn.addEventListener('click', () => {
  void start()
})

// --- boot -------------------------------------------------------------------

async function boot(): Promise<void> {
  if (window.cate) {
    try {
      applyTheme(await cate.theme.get())
    } catch {
      /* keep default colors */
    }
    cate.storage.onChange?.(() => {
      // No cross-panel state to react to yet; hook is here for future use.
    })
  }
  void start()
}

void boot()
