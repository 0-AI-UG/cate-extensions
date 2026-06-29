// MCPHub panel. External script (CSP-safe, no inline JS). It:
//   - themes the chrome from cate.theme.get() via the shared kit
//   - asks the wrapper to start MCPHub, polls /__mcphub/status, and drives the
//     shared ServiceConnection widget (provisioning / error+retry / ready)
//   - on ready, embeds the proxied dashboard in an iframe
//
// All fetch/iframe URLs are relative so they tunnel through Cate's proxy, which
// injects the bearer; the page never holds a token.

import '../_kit/cate-kit.css'
import { initTheme } from '../_kit/theme'
import { ServiceConnection } from '../_kit/service-connection'

// MCPHub is mounted under this base path by the wrapper (kept in sync with
// MCPHUB_BASE_PATH in src/mcphub.ts); the shell itself lives at "/".
const DASH_PATH = '/__mcphub/dash'
const PANEL_STATE_KEY = 'shell'

interface WrapperStatus {
  status: 'idle' | 'starting' | 'ready' | 'error'
  via?: string | null
  error?: string | null
  stderrTail?: string[]
}

const ICON =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="2" fill="none" stroke="currentColor"/><circle cx="3" cy="3" r="1.5" fill="none" stroke="currentColor"/><circle cx="13" cy="3" r="1.5" fill="none" stroke="currentColor"/><circle cx="3" cy="13" r="1.5" fill="none" stroke="currentColor"/><circle cx="13" cy="13" r="1.5" fill="none" stroke="currentColor"/><path d="M6.5 6.5 4 4M9.5 6.5 12 4M6.5 9.5 4 12M9.5 9.5 12 12" stroke="currentColor"/></svg>'

const conn = new ServiceConnection(document.getElementById('root')!, {
  serviceName: 'MCPHub',
  icon: ICON,
  description: 'A local MCPHub install is launched and embedded here. The first run may download it.',
  onRetry: () => void start(),
  onReady: (mount) => {
    const frame = document.createElement('iframe')
    frame.title = 'MCPHub dashboard'
    frame.src = DASH_PATH
    mount.appendChild(frame)
    cate?.panel.setTitle('MCPHub').catch(() => {})
    cate?.ui.notify('MCPHub is ready.', 'info').catch(() => {})
  },
})

let notifiedError = false
let pollTimer: ReturnType<typeof setTimeout> | null = null

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
      'No MCPHub install was found. Install it (npm i -g @samanhappy/mcphub) or set MCPHUB_CMD.',
    detail: s.stderrTail && s.stderrTail.length ? s.stderrTail.join('\n') : undefined,
    canRetry: true,
  })
  rememberStatus('error')
  if (!notifiedError) {
    notifiedError = true
    cate?.ui.notify('MCPHub failed to start. See the panel for details.', 'error').catch(() => {})
  }
}

function showStarting(s: WrapperStatus): void {
  conn.setState({
    kind: 'provisioning',
    message: s.via
      ? `Launching via ${s.via}. First run may download MCPHub.`
      : 'Resolving a MCPHub install on this machine…',
    log: s.stderrTail && s.stderrTail.length ? s.stderrTail.join('\n') : undefined,
  })
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
    showError({ status: 'error', error: 'Lost contact with the wrapper: ' + String(err) })
    return
  }
  if (s.status === 'ready') {
    conn.setState({ kind: 'ready' })
    rememberStatus('ready')
    return
  }
  if (s.status === 'error') {
    showError(s)
    return
  }
  showStarting(s)
  pollTimer = setTimeout(() => void poll(), 600)
}

async function start(): Promise<void> {
  notifiedError = false
  conn.setState({ kind: 'provisioning' })
  rememberStatus('starting')
  try {
    await fetch('/__mcphub/start', { method: 'POST' })
  } catch {
    /* poll() will report the failure */
  }
  if (pollTimer) clearTimeout(pollTimer)
  void poll()
}

async function boot(): Promise<void> {
  await initTheme()
  void start()
}

void boot()
