// @ts-check
/// <reference path="./cate-host.d.ts" />
// =============================================================================
// Frontend Kit panel — drives every layer of the Cate extension bridge that is
// reachable WITHOUT a server. This is a frontend-only extension: Cate serves
// these static assets directly through its proxy (no daemon-hosted server, no
// HTTP/WS tunnel, no CATE_API). Everything here goes through `window.cate`.
//
// Plain classic script (no module syntax) so it loads via <script src> under a
// strict CSP and stays trivially testable in a DOM harness.
// =============================================================================

/** @param {unknown[]} args */
function log(...args) {
  const el = document.getElementById('log')
  if (!el) return
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  el.textContent += line + '\n'
  el.scrollTop = el.scrollHeight
}

/** @param {string} id @param {string} text */
function set(id, text) {
  const el = document.getElementById(id)
  if (el) el.textContent = text
}

/** @param {string} id */
function byId(id) {
  const el = document.getElementById(id)
  if (!el) throw new Error('missing #' + id)
  return el
}

// --- cateHost bridge --------------------------------------------------------

async function initBridge() {
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

  try {
    const theme = await cate.theme.get()
    set('theme', `${theme.id} (${theme.type})`)
    applyTheme(theme)
  } catch (err) {
    set('theme', 'error: ' + String(err))
  }
}

/** Map a few Cate app theme tokens onto our CSS variables, probing common
 *  names and falling back gracefully.
 *  @param {CateHostTheme} theme */
function applyTheme(theme) {
  const app = theme.app || {}
  /** @param {string[]} keys */
  const pick = (...keys) => {
    for (const k of keys) if (app[k]) return app[k]
    return null
  }
  const root = document.documentElement.style
  const bg = pick('editor-bg', 'app-bg', 'bg', 'background')
  const fg = pick('editor-fg', 'app-fg', 'fg', 'foreground', 'text')
  const accent = pick('accent', 'focus', 'primary', 'link')
  const panel = pick('panel-bg', 'sidebar-bg', 'titlebar-bg')
  if (bg) root.setProperty('--fk-bg', bg)
  if (fg) root.setProperty('--fk-fg', fg)
  if (accent) root.setProperty('--fk-accent', accent)
  if (panel) root.setProperty('--fk-panel', panel)
  document.documentElement.dataset.themeType = theme.type || 'dark'
}

// --- storage ----------------------------------------------------------------

const NOTES_KEY = 'frontendkit:notes'
const PANEL_COUNTER_KEY = 'counter'
/** @type {ReturnType<typeof setTimeout> | null} */
let saveTimer = null
let changeCount = 0

async function initNotes() {
  if (!window.cate) return
  const notes = /** @type {HTMLTextAreaElement} */ (byId('notes'))
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
  // React to external/other-panel storage edits — surface a live count.
  cate.storage.onChange((key) => {
    changeCount += 1
    set('change-count', String(changeCount))
    log('storage.change event received', key ? `(key: ${key})` : '')
  })
}

async function initStorageApi() {
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
      ;(/** @type {HTMLTextAreaElement} */ (byId('notes'))).value = ''
      set('notes-status', 'deleted')
      log('storage.delete', NOTES_KEY)
    } catch (err) {
      log('storage.delete failed:', String(err))
    }
  })

  // Panel-scoped counter: persisted under THIS panel's id, so each panel
  // instance keeps its own value (proves cate.storage.panel.get/set).
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

// --- reverse-API actions ----------------------------------------------------

function initActions() {
  if (!window.cate) return

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

  byId('spawn-panel').addEventListener('click', async () => {
    try {
      const res = await cate.canvas.createPanel('extension', {
        // @ts-expect-error extension panels carry id fields beyond the base type
        extensionId: 'cate.frontendkit',
        extensionPanelId: 'about',
      })
      log('canvas.createPanel ->', res)
    } catch (err) {
      log('canvas.createPanel failed:', String(err))
    }
  })

  byId('set-title').addEventListener('click', async () => {
    const title = 'Frontend Kit @ ' + new Date().toLocaleTimeString()
    try {
      await cate.panel.setTitle(title)
      log('panel.setTitle ->', title)
    } catch (err) {
      log('panel.setTitle failed:', String(err))
    }
  })

  byId('notify').addEventListener('click', async () => {
    try {
      const res = await cate.ui.notify('Hello from Frontend Kit', 'info')
      log('ui.notify ->', res)
    } catch (err) {
      log('ui.notify failed:', String(err))
    }
  })
}

// --- boot -------------------------------------------------------------------

initBridge()
initNotes()
initStorageApi()
initActions()
