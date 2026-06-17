// =============================================================================
// Kitchen Sink panel — drives every layer of the Cate extension stack from the
// page. CSP-safe: this is an external script, no inline JS. All requests/WS go
// to RELATIVE URLs so they resolve under /ext/<routeToken>/ and tunnel through
// the proxy (which injects the bearer); the page itself never holds a token.
// Authored in TypeScript; `npm run build` compiles this to dist/public/app.js.
// =============================================================================

const logEl = document.getElementById('log') as HTMLElement

function log(...args: unknown[]): void {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  logEl.textContent += line + '\n'
  logEl.scrollTop = logEl.scrollHeight
}

function set(id: string, text: string): void {
  const el = document.getElementById(id)
  if (el) el.textContent = text
}

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T
}

// Base path for our own server, e.g. "/ext/<routeToken>/". location.pathname is
// either that dir or a file under it; trim to the trailing slash.
const BASE = location.pathname.replace(/[^/]*$/, '')

// --- cateHost bridge --------------------------------------------------------

async function initBridge(): Promise<void> {
  if (!window.cate) {
    set('version', 'window.cate missing — preload not injected')
    log('FATAL: cateHost preload not injected')
    return
  }
  try {
    set('version', String(await cate.version()))
  } catch (err) {
    set('version', 'error: ' + String(err))
  }
  set('panel', cate.panel.id || '(none)')

  try {
    const ws = await cate.workspace.get()
    set('workspace', ws.rootPath || '(none)')
  } catch (err) {
    set('workspace', 'error: ' + String(err))
  }

  // Apply theme tokens to the panel's CSS variables.
  try {
    const theme = await cate.theme.get()
    set('theme', `${theme.id} (${theme.type})`)
    applyTheme(theme)
  } catch (err) {
    set('theme', 'error: ' + String(err))
  }
}

/** Map a few Cate app theme tokens onto our CSS variables. Token keys vary by
 *  theme, so we probe several common names and fall back gracefully. */
function applyTheme(theme: CateHostTheme): void {
  const app = theme.app || {}
  const pick = (...keys: string[]): string | null => {
    for (const k of keys) if (app[k]) return app[k]
    return null
  }
  const root = document.documentElement.style
  const bg = pick('editor-bg', 'app-bg', 'bg', 'background')
  const fg = pick('editor-fg', 'app-fg', 'fg', 'foreground', 'text')
  const accent = pick('accent', 'focus', 'primary', 'link')
  const panel = pick('panel-bg', 'sidebar-bg', 'titlebar-bg')
  if (bg) root.setProperty('--ks-bg', bg)
  if (fg) root.setProperty('--ks-fg', fg)
  if (accent) root.setProperty('--ks-accent', accent)
  if (panel) root.setProperty('--ks-panel', panel)
  document.documentElement.dataset.themeType = theme.type || 'dark'
}

// --- storage autosave -------------------------------------------------------

const NOTES_KEY = 'kitchensink:notes'
const PANEL_COUNTER_KEY = 'counter'
let saveTimer: ReturnType<typeof setTimeout> | null = null
let changeCount = 0

async function initNotes(): Promise<void> {
  if (!window.cate) return
  const notes = byId<HTMLTextAreaElement>('notes')
  try {
    const saved = await cate.storage.get(NOTES_KEY)
    if (typeof saved === 'string') notes.value = saved
    set('notes-status', 'restored')
  } catch {
    set('notes-status', 'no prior value')
  }
  notes.addEventListener('input', () => {
    set('notes-status', 'editing…')
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(async () => {
      try {
        await cate.storage.set(NOTES_KEY, notes.value)
        set('notes-status', 'autosaved ✓')
      } catch (err) {
        set('notes-status', 'save failed: ' + String(err))
      }
    }, 400)
  })
  // React to external/other-panel storage edits — surface a live count so a
  // second panel editing its notes visibly ticks this panel's counter.
  cate.storage.onChange((key) => {
    changeCount += 1
    set('change-count', String(changeCount))
    log('storage.change event received', key ? `(key: ${key})` : '')
  })
}

// --- storage full API (delete / keys / panel-scoped) ------------------------

async function initStorageApi(): Promise<void> {
  if (!window.cate) return

  byId('storage-keys').addEventListener('click', async () => {
    try {
      const keys = await cate.storage.keys()
      set('keys-out', keys.length ? keys.join(', ') : '(none)')
    } catch (err) {
      set('keys-out', 'error: ' + String(err))
    }
  })

  byId('storage-delete-notes').addEventListener('click', async () => {
    try {
      await cate.storage.delete(NOTES_KEY)
      byId<HTMLTextAreaElement>('notes').value = ''
      set('notes-status', 'deleted')
      log('storage.delete', NOTES_KEY)
    } catch (err) {
      log('storage.delete failed:', String(err))
    }
  })

  // Panel-scoped counter: persisted under THIS panel's id, so each panel
  // instance keeps its own value (proves cate.storage.panel.get/set).
  const showCounter = async (): Promise<void> => {
    try {
      const cur = await cate.storage.panel.get(PANEL_COUNTER_KEY)
      set('panel-counter', typeof cur === 'number' ? String(cur) : '0')
    } catch (err) {
      set('panel-counter', 'error: ' + String(err))
    }
  }
  byId('panel-bump').addEventListener('click', async () => {
    try {
      const cur = await cate.storage.panel.get(PANEL_COUNTER_KEY)
      const next = (typeof cur === 'number' ? cur : 0) + 1
      await cate.storage.panel.set(PANEL_COUNTER_KEY, next)
      set('panel-counter', String(next))
    } catch (err) {
      set('panel-counter', 'error: ' + String(err))
    }
  })
  await showCounter()
}

// --- reverse-API actions ----------------------------------------------------

function initActions(): void {
  byId('open-file').addEventListener('click', async () => {
    try {
      const res = await cate.editor.openFile('package.json')
      log('editor.openFile package.json ->', res)
    } catch (err) {
      log('editor.openFile failed:', String(err))
    }
  })

  byId('open-file-line').addEventListener('click', async () => {
    try {
      const res = await cate.editor.openFile('package.json', { line: 2, column: 3 })
      log('editor.openFile package.json @2:3 ->', res)
    } catch (err) {
      log('editor.openFile (line) failed:', String(err))
    }
  })

  byId('notify').addEventListener('click', async () => {
    try {
      const res = await cate.ui.notify('Hello from Kitchen Sink', 'info')
      log('ui.notify ->', res)
    } catch (err) {
      log('ui.notify failed:', String(err))
    }
  })

  byId('spawn-panel').addEventListener('click', async () => {
    try {
      const res = await cate.canvas.createPanel('extension', {
        extensionId: 'cate.kitchensink',
        extensionPanelId: 'main',
      } as unknown as Parameters<typeof cate.canvas.createPanel>[1])
      log('canvas.createPanel ->', res)
    } catch (err) {
      log('canvas.createPanel failed:', String(err))
    }
  })

  byId('set-title').addEventListener('click', async () => {
    const title = 'Kitchen Sink @ ' + new Date().toLocaleTimeString()
    try {
      await cate.panel.setTitle(title)
      log('panel.setTitle ->', title)
    } catch (err) {
      log('panel.setTitle failed:', String(err))
    }
  })
}

// --- HTTP tunnel ------------------------------------------------------------

function initHttp(): void {
  byId('call-info').addEventListener('click', async () => {
    try {
      const res = await fetch(BASE + 'api/info')
      const json = await res.json()
      byId('http-out').textContent = 'GET /api/info -> ' + JSON.stringify(json, null, 2)
    } catch (err) {
      byId('http-out').textContent = 'GET /api/info failed: ' + String(err)
    }
  })

  byId('call-echo').addEventListener('click', async () => {
    try {
      const body = { hello: 'from the page', at: Date.now() }
      const res = await fetch(BASE + 'api/echo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      byId('http-out').textContent = 'POST /api/echo -> ' + JSON.stringify(json, null, 2)
    } catch (err) {
      byId('http-out').textContent = 'POST /api/echo failed: ' + String(err)
    }
  })
}

// --- WebSocket tunnel -------------------------------------------------------

let ws: WebSocket | null = null

function initWs(): void {
  const out = byId('ws-out')
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const wsUrl = proto + '//' + location.host + BASE + 'ws'
  try {
    ws = new WebSocket(wsUrl)
  } catch (err) {
    out.textContent = 'WebSocket construction failed: ' + String(err)
    return
  }
  ws.onopen = () => {
    out.textContent = 'WebSocket open ✓'
  }
  ws.onmessage = (e) => {
    out.textContent += '\n< ' + e.data
  }
  ws.onerror = () => {
    out.textContent += '\nWebSocket error'
  }
  ws.onclose = () => {
    out.textContent += '\nWebSocket closed'
  }

  byId('ws-send').addEventListener('click', () => {
    const msg = byId<HTMLInputElement>('ws-input').value
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(msg)
      out.textContent += '\n> ' + msg
    } else {
      out.textContent += '\nWS not open'
    }
  })
}

// --- CATE_API reverse -------------------------------------------------------

function initRoundtrip(): void {
  byId('roundtrip').addEventListener('click', async () => {
    const out = byId('roundtrip-out')
    out.textContent = 'running…'
    try {
      const res = await fetch(BASE + 'api/cate-roundtrip', { method: 'POST' })
      const json = await res.json()
      out.textContent = (json.ok ? 'OK ✓ ' : 'MISMATCH ✗ ') + JSON.stringify(json, null, 2)
    } catch (err) {
      out.textContent = 'failed: ' + String(err)
    }
  })
}

// --- boot -------------------------------------------------------------------

initBridge()
initNotes()
initStorageApi()
initActions()
initHttp()
initWs()
initRoundtrip()
