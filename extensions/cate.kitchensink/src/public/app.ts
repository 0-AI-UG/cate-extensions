// Kitchen Sink panel. External script (CSP-safe, no inline JS). All fetch/WS use
// relative URLs so they resolve under /ext/<routeToken>/ and tunnel through the
// proxy, which injects the bearer; the page never holds a token.

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

// Base path for our own server, e.g. "/ext/<routeToken>/".
const BASE = location.pathname.replace(/[^/]*$/, '')

// --- bridge -----------------------------------------------------------------

async function initBridge(): Promise<void> {
  if (!window.cate) {
    set('version', 'window.cate missing')
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

  try {
    const theme = await cate.theme.get()
    set('theme', `${theme.id} (${theme.type})`)
    applyTheme(theme)
  } catch (err) {
    set('theme', 'error: ' + String(err))
  }
}

/** Map Cate's theme background/foreground onto our CSS variables. */
function applyTheme(theme: CateHostTheme): void {
  const app = theme.app || {}
  const pick = (...keys: string[]): string | null => {
    for (const k of keys) if (app[k]) return app[k]
    return null
  }
  const root = document.documentElement.style
  const bg = pick('editor-bg', 'app-bg', 'bg', 'background')
  const fg = pick('editor-fg', 'app-fg', 'fg', 'foreground', 'text')
  if (bg) root.setProperty('--ks-bg', bg)
  if (fg) root.setProperty('--ks-fg', fg)
}

// --- storage ----------------------------------------------------------------

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
    set('notes-status', 'editing')
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(async () => {
      try {
        await cate.storage.set(NOTES_KEY, notes.value)
        set('notes-status', 'autosaved')
      } catch (err) {
        set('notes-status', 'save failed: ' + String(err))
      }
    }, 400)
  })
  cate.storage.onChange((key) => {
    changeCount += 1
    set('change-count', String(changeCount))
    log('storage.change', key ? `(${key})` : '')
  })
}

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
    } catch (err) {
      log('storage.delete failed:', String(err))
    }
  })

  // Counter persisted under this panel's id via cate.storage.panel.
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

  try {
    const cur = await cate.storage.panel.get(PANEL_COUNTER_KEY)
    set('panel-counter', typeof cur === 'number' ? String(cur) : '0')
  } catch {
    set('panel-counter', '0')
  }
}

// --- actions ----------------------------------------------------------------

function initActions(): void {
  byId('open-file').addEventListener('click', async () => {
    try {
      log('editor.openFile ->', await cate.editor.openFile('package.json'))
    } catch (err) {
      log('editor.openFile failed:', String(err))
    }
  })

  byId('open-file-line').addEventListener('click', async () => {
    try {
      log('editor.openFile @2:3 ->', await cate.editor.openFile('package.json', { line: 2, column: 3 }))
    } catch (err) {
      log('editor.openFile failed:', String(err))
    }
  })

  byId('notify').addEventListener('click', async () => {
    try {
      log('ui.notify ->', await cate.ui.notify('Hello from Kitchen Sink', 'info'))
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

// --- http to our own server -------------------------------------------------

function initHttp(): void {
  byId('call-info').addEventListener('click', async () => {
    try {
      const res = await fetch(BASE + 'api/info')
      byId('http-out').textContent = JSON.stringify(await res.json(), null, 2)
    } catch (err) {
      byId('http-out').textContent = 'failed: ' + String(err)
    }
  })

  byId('call-echo').addEventListener('click', async () => {
    try {
      const res = await fetch(BASE + 'api/echo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hello: 'from the page', at: Date.now() }),
      })
      byId('http-out').textContent = JSON.stringify(await res.json(), null, 2)
    } catch (err) {
      byId('http-out').textContent = 'failed: ' + String(err)
    }
  })
}

// --- websocket --------------------------------------------------------------

let ws: WebSocket | null = null

function initWs(): void {
  const out = byId('ws-out')
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  try {
    ws = new WebSocket(proto + '//' + location.host + BASE + 'ws')
  } catch (err) {
    out.textContent = 'failed: ' + String(err)
    return
  }
  ws.onopen = () => { out.textContent = 'open' }
  ws.onmessage = (e) => { out.textContent += '\n< ' + e.data }
  ws.onerror = () => { out.textContent += '\nerror' }
  ws.onclose = () => { out.textContent += '\nclosed' }

  byId('ws-send').addEventListener('click', () => {
    const msg = byId<HTMLInputElement>('ws-input').value
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(msg)
      out.textContent += '\n> ' + msg
    } else {
      out.textContent += '\nnot open'
    }
  })
}

// --- server to cate (CATE_API) ----------------------------------------------

function initRoundtrip(): void {
  byId('roundtrip').addEventListener('click', async () => {
    const out = byId('roundtrip-out')
    out.textContent = 'running'
    try {
      const res = await fetch(BASE + 'api/cate-roundtrip', { method: 'POST' })
      const json = await res.json()
      out.textContent = (json.ok ? 'ok ' : 'mismatch ') + JSON.stringify(json, null, 2)
    } catch (err) {
      out.textContent = 'failed: ' + String(err)
    }
  })
}

// --- agent ------------------------------------------------------------------

// A real multi-turn conversation through window.cate.agent. pi owns the history;
// we hold only the session handle (persisted under storage so it survives a
// panel reload — open() with `resume` rehydrates pi's context).
function initAgent(): void {
  if (!window.cate) return
  const out = byId('agent-out')
  const SESSION_KEY = 'kitchensink:agent-session'
  let sessionId: string | null = null
  let busy = false
  const transcript: string[] = []
  const render = (status?: string) => {
    out.textContent = (status ? status + '\n\n' : '') + transcript.join('\n\n')
  }

  // Ensure a live session, resuming the persisted handle if we have one.
  async function ensureSession(): Promise<string> {
    if (sessionId) return sessionId
    const resume = (await cate.storage.get(SESSION_KEY)) as string | undefined
    const res = await cate.agent.open(resume ? { resume } : undefined)
    if ('error' in res) throw new Error(res.error)
    sessionId = res.sessionId
    await cate.storage.set(SESSION_KEY, sessionId)
    return sessionId
  }

  byId('agent-run').addEventListener('click', async () => {
    if (busy) return
    const prompt = byId<HTMLInputElement>('agent-input').value.trim()
    if (!prompt) return
    busy = true
    transcript.push('you: ' + prompt)
    render('thinking…')
    try {
      const id = await ensureSession()
      const res = await cate.agent.send(id, prompt)
      if ('error' in res) {
        transcript.push('error: ' + res.error)
      } else {
        // Show the flattened text, and the raw message so the whole thing is visible.
        transcript.push('agent: ' + (res.text || '(no text)'))
        log('agent message ->', res.message)
      }
    } catch (err) {
      transcript.push('error: ' + String(err))
    } finally {
      busy = false
      render()
    }
  })

  byId('agent-end').addEventListener('click', async () => {
    if (sessionId) { try { await cate.agent.dispose(sessionId) } catch { /* ignore */ } }
    sessionId = null
    await cate.storage.delete(SESSION_KEY)
    transcript.length = 0
    render('(session ended)')
  })
}

initBridge()
initNotes()
initStorageApi()
initActions()
initHttp()
initWs()
initRoundtrip()
initAgent()
