// DeepWiki panel (connect-only). External script (CSP-safe). All fetch uses
// relative URLs so they resolve under /ext/<routeToken>/ and tunnel through
// Cate's proxy.
//
// Responsibilities:
//   - Theme the chrome from cate.theme.get().
//   - Let the user configure the URL of a DeepWiki instance they run themselves,
//     and show connection status.
//   - Surface a ready-to-paste .env derived from Cate's configured AI provider.
//   - Embed the proxied DeepWiki UI in an iframe and route code-reference clicks
//     to cate.editor.openFile(path, { line }) instead of navigating.

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

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T
}
function set(id: string, text: string): void {
  const el = document.getElementById(id)
  if (el) el.textContent = text
}

// --- theming ----------------------------------------------------------------

async function applyTheme(): Promise<void> {
  if (!window.cate) return
  try {
    const theme = await cate.theme.get()
    const app = theme.app || {}
    const pick = (...keys: string[]): string | null => {
      for (const k of keys) if (app[k]) return app[k]
      return null
    }
    const root = document.documentElement.style
    const bg = pick('editor-bg', 'app-bg', 'bg', 'background')
    const fg = pick('editor-fg', 'app-fg', 'fg', 'foreground', 'text')
    const accent = pick('accent', 'focus-border', 'link', 'button-bg')
    const border = pick('border', 'panel-border', 'editor-line')
    if (bg) root.setProperty('--dw-bg', bg)
    if (fg) root.setProperty('--dw-fg', fg)
    if (accent) root.setProperty('--dw-accent', accent)
    if (border) root.setProperty('--dw-border', border)
  } catch {
    /* keep defaults */
  }
}

// --- status -----------------------------------------------------------------

interface Status {
  upstream: string | null
  reachable: boolean
  workspaceRoot: string | null
  cateProviders: string[]
  canReuseCateProvider: boolean
}

async function refreshStatus(): Promise<void> {
  const conn = byId('conn')
  try {
    const res = await fetch(BASE + 'api/status')
    const s: Status = await res.json()
    renderStatus(s)
  } catch (err) {
    conn.textContent = 'error'
    conn.className = 'pill pill-bad'
    set('status-line', 'status check failed: ' + String(err))
  }
}

function renderStatus(s: Status): void {
  const conn = byId('conn')
  set('providers', s.cateProviders.length ? s.cateProviders.join(', ') : '(none configured)')
  if (s.upstream) byId<HTMLInputElement>('upstream').value = s.upstream

  // Connection pill + status line.
  let label: string
  let cls: string
  if (!s.upstream) {
    label = 'not configured'
    cls = 'pill-unknown'
    set('status-line', 'enter the URL of a DeepWiki instance you run')
  } else if (s.reachable) {
    label = 'connected'
    cls = 'pill-ok'
    set('status-line', 'connected to ' + s.upstream)
  } else {
    label = 'unreachable'
    cls = 'pill-bad'
    set('status-line', 'configured ' + s.upstream + ' but it is not responding')
  }
  conn.textContent = label
  conn.className = 'pill ' + cls

  // Show "disconnect" only when an upstream is configured.
  byId('disconnect').classList.toggle('hidden', !s.upstream)

  // Embed the wiki once an upstream is configured (even if currently unreachable,
  // so the user sees the upstream's own error rather than a blank panel).
  showWiki(Boolean(s.upstream))
  if (s.canReuseCateProvider) void loadEnv()
}

async function loadEnv(): Promise<void> {
  try {
    const res = await fetch(BASE + 'api/env')
    const { dotenv } = (await res.json()) as { dotenv: string }
    set('env-out', dotenv || '(no reusable provider key found in Cate)')
  } catch {
    /* leave placeholder */
  }
}

// --- wiki iframe + code-reference glue --------------------------------------

let wikiShown = false

function showWiki(reachable: boolean): void {
  const iframe = byId<HTMLIFrameElement>('wiki')
  const setup = byId('setup')
  if (reachable) {
    if (!wikiShown) {
      // Load our own origin root, which the server reverse-proxies to upstream.
      iframe.src = BASE
      wikiShown = true
    }
    setup.classList.add('hidden')
    iframe.classList.remove('hidden')
  } else {
    setup.classList.remove('hidden')
    iframe.classList.add('hidden')
  }
}

// Intercept clicks inside the proxied DeepWiki UI (same-origin, so we can reach
// its document) and route code references to Cate's editor. Re-attaches on each
// navigation. If the document is ever cross-origin/inaccessible, we silently
// fall back to normal in-iframe navigation.
function attachIframeGlue(): void {
  const iframe = byId<HTMLIFrameElement>('wiki')
  iframe.addEventListener('load', () => {
    let doc: Document | null = null
    try {
      doc = iframe.contentDocument
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

// --- wiring -----------------------------------------------------------------

function initControls(): void {
  byId('refresh').addEventListener('click', () => void refreshStatus())

  byId('toggle-setup').addEventListener('click', () => {
    byId('setup').classList.toggle('hidden')
  })

  const reload = (): void => {
    wikiShown = false
    byId<HTMLIFrameElement>('wiki').src = 'about:blank'
  }

  byId('save-upstream').addEventListener('click', async () => {
    const upstream = byId<HTMLInputElement>('upstream').value.trim()
    if (!upstream) return
    set('status-line', 'connecting…')
    try {
      const res = await fetch(BASE + 'api/upstream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ upstream }),
      })
      const json = (await res.json()) as { ok?: boolean; error?: string }
      if (!json.ok) {
        set('status-line', 'invalid URL: ' + (json.error || ''))
        return
      }
      reload()
      await refreshStatus()
    } catch (err) {
      set('status-line', 'failed: ' + String(err))
    }
  })

  // Clear the configured upstream -> back to the config page.
  byId('disconnect').addEventListener('click', async () => {
    set('status-line', 'disconnecting…')
    try {
      await fetch(BASE + 'api/upstream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ upstream: null }),
      })
      byId<HTMLInputElement>('upstream').value = ''
      reload()
      await refreshStatus()
    } catch (err) {
      set('status-line', 'failed: ' + String(err))
    }
  })

  byId('copy-env').addEventListener('click', async () => {
    const text = byId('env-out').textContent || ''
    try {
      await navigator.clipboard.writeText(text)
      await cate.ui.notify('DeepWiki .env copied to clipboard', 'info')
    } catch {
      /* clipboard may be blocked; user can select manually */
    }
  })
}

void applyTheme()
initControls()
attachIframeGlue()
attachMessageGlue()
void refreshStatus()
