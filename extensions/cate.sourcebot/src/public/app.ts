// Sourcebot panel. External script only (CSP-safe). All fetch/iframe URLs are
// relative so they resolve under /ext/<routeToken>/ and tunnel through Cate's
// proxy (which injects the per-server bearer). The page never holds a token.
//
// Two modes:
//   - Native search: POST ./sbapi/search, render flat hits, and on click call
//     cate.editor.openFile(path, { line }) to open the hit in a Cate editor.
//   - Browse: load the full Sourcebot UI in an iframe pointed at ./sb/ (the
//     server reverse-proxies it same-origin).
//
// Connection config (Sourcebot base URL + optional API key) is stored via
// cate.storage so the server can read it back over CATE_API; the key never
// rides in a URL the webview can read.

// Base path for our own server, e.g. "/ext/<routeToken>/".
const BASE = location.pathname.replace(/[^/]*$/, '')

const KEY_BASE_URL = 'sourcebot:baseUrl'
const KEY_API_KEY = 'sourcebot:apiKey'

interface SearchHit {
  repository: string
  path: string
  line: number
  snippet: string
  webUrl?: string
  language?: string
}

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T
}

function setStatus(text: string, isError = false): void {
  const el = byId('status')
  el.textContent = text
  el.classList.toggle('error', isError)
}

// --- theming ----------------------------------------------------------------

function applyTheme(theme: CateHostTheme): void {
  const app = theme.app || {}
  const pick = (...keys: string[]): string | null => {
    for (const k of keys) if (app[k]) return app[k]
    return null
  }
  const root = document.documentElement.style
  const set = (cssVar: string, value: string | null): void => {
    if (value) root.setProperty(cssVar, value)
  }
  set('--sb-bg', pick('editor-bg', 'app-bg', 'bg', 'background'))
  set('--sb-fg', pick('editor-fg', 'app-fg', 'fg', 'foreground', 'text'))
  set('--sb-muted', pick('text-muted', 'muted', 'fg-muted'))
  set('--sb-accent', pick('accent', 'accent-fg', 'link', 'primary'))
  set('--sb-surface', pick('surface-1', 'surface', 'panel-bg', 'sidebar-bg'))
  set('--sb-border', pick('border', 'border-muted', 'divider'))
}

async function initTheme(): Promise<void> {
  if (!window.cate) return
  try {
    applyTheme(await cate.theme.get())
  } catch {
    /* keep defaults */
  }
}

// --- config -----------------------------------------------------------------

interface ConfigStatus {
  configured: boolean
  baseUrl?: string
  hasKey?: boolean
  reachable?: boolean
  probeStatus?: number
  probeError?: string
  error?: string
}

async function fetchConfig(): Promise<ConfigStatus> {
  const res = await fetch(BASE + 'api/config')
  return (await res.json()) as ConfigStatus
}

function showSettings(show: boolean): void {
  byId('settings').classList.toggle('hidden', !show)
}

async function openSettings(): Promise<void> {
  if (window.cate) {
    const url = await cate.storage.get(KEY_BASE_URL)
    const key = await cate.storage.get(KEY_API_KEY)
    byId<HTMLInputElement>('cfg-url').value = typeof url === 'string' ? url : ''
    byId<HTMLInputElement>('cfg-key').value = typeof key === 'string' ? key : ''
  }
  showSettings(true)
}

function initSettings(): void {
  byId('settings-btn').addEventListener('click', () => void openSettings())
  byId('cfg-cancel').addEventListener('click', () => showSettings(false))

  byId('cfg-save').addEventListener('click', async () => {
    const url = byId<HTMLInputElement>('cfg-url').value.trim()
    const key = byId<HTMLInputElement>('cfg-key').value.trim()
    const out = byId('cfg-result')
    out.className = 'cfg-result'
    if (!url) {
      out.textContent = 'A base URL is required.'
      out.classList.add('error')
      return
    }
    if (!window.cate) {
      out.textContent = 'window.cate unavailable; cannot persist config.'
      out.classList.add('error')
      return
    }
    out.textContent = 'Saving and testing…'
    try {
      await cate.storage.set(KEY_BASE_URL, url)
      await cate.storage.set(KEY_API_KEY, key)
      const cfg = await fetchConfig()
      if (!cfg.configured) {
        out.textContent = 'Saved, but the URL was rejected: ' + (cfg.error || 'invalid URL')
        out.classList.add('error')
        return
      }
      if (cfg.reachable) {
        out.textContent = `Connected to ${cfg.baseUrl}${cfg.hasKey ? ' (with API key)' : ''}.`
        out.classList.add('ok')
        showSettings(false)
        await refreshStatusLine()
      } else {
        out.textContent =
          `Saved ${cfg.baseUrl}, but it was not reachable: ${cfg.probeError || 'no response'}.\n` +
          'Check the instance is running and the URL is correct.'
        out.classList.add('error')
      }
    } catch (err) {
      out.textContent = 'Failed: ' + String(err)
      out.classList.add('error')
    }
  })
}

async function refreshStatusLine(): Promise<ConfigStatus> {
  let cfg: ConfigStatus
  try {
    cfg = await fetchConfig()
  } catch (err) {
    setStatus('Cannot reach the extension server: ' + String(err), true)
    return { configured: false }
  }
  if (!cfg.configured) {
    setStatus('No Sourcebot configured. Click ⚙ to connect.', true)
    void openSettings()
  } else if (!cfg.reachable) {
    setStatus(`${cfg.baseUrl} unreachable (${cfg.probeError || 'no response'}). Click ⚙ to fix.`, true)
  } else {
    setStatus(`Connected: ${cfg.baseUrl}`)
  }
  return cfg
}

// --- native search ----------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      default: return '&#39;'
    }
  })
}

function renderResults(hits: SearchHit[], totalMatches: number | null): void {
  const root = byId('results')
  root.innerHTML = ''
  if (hits.length === 0) {
    const div = document.createElement('div')
    div.className = 'empty'
    div.textContent = 'No matches.'
    root.appendChild(div)
    return
  }

  // Group by repository for a Sourcegraph-like layout.
  const groups = new Map<string, SearchHit[]>()
  for (const h of hits) {
    const list = groups.get(h.repository) ?? []
    list.push(h)
    groups.set(h.repository, list)
  }

  for (const [repo, list] of groups) {
    const group = document.createElement('div')
    group.className = 'repo-group'
    const head = document.createElement('div')
    head.className = 'repo-head'
    head.textContent = repo || '(unknown repository)'
    group.appendChild(head)

    for (const hit of list) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'hit'
      btn.innerHTML =
        `<span class="hit-path">${escapeHtml(hit.path)}</span>` +
        `<span class="hit-line"> : ${hit.line}</span>` +
        (hit.snippet ? `<pre class="hit-snippet">${escapeHtml(hit.snippet)}</pre>` : '')
      btn.addEventListener('click', () => void openHit(hit))
      group.appendChild(btn)
    }
    root.appendChild(group)
  }

  const count =
    totalMatches != null ? `${hits.length} shown · ${totalMatches} total matches` : `${hits.length} results`
  setStatus(count)
}

/** Open a hit in a Cate editor. Sourcebot reports repo-relative paths; we hand
 *  them straight to cate.editor.openFile, which confines them to the workspace
 *  root. If the repo doesn't live under the workspace, the host rejects it and
 *  we surface that to the user. */
async function openHit(hit: SearchHit): Promise<void> {
  if (!window.cate) {
    setStatus('window.cate unavailable; cannot open files.', true)
    return
  }
  try {
    const res = (await cate.editor.openFile(hit.path, { line: hit.line })) as
      | { error?: string }
      | undefined
    if (res && typeof res === 'object' && 'error' in res && res.error) {
      setStatus(`Could not open ${hit.path}: ${res.error}`, true)
    } else {
      setStatus(`Opened ${hit.path}:${hit.line}`)
    }
  } catch (err) {
    setStatus('openFile failed: ' + String(err), true)
  }
}

async function runSearch(): Promise<void> {
  const query = byId<HTMLInputElement>('query').value.trim()
  if (!query) return
  // Leave browse mode if active.
  byId('browse').classList.add('hidden')
  byId('results').classList.remove('hidden')

  setStatus('Searching…')
  try {
    const res = await fetch(BASE + 'sbapi/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        matches: 50,
        isRegexEnabled: byId<HTMLInputElement>('regex').checked,
        isCaseSensitivityEnabled: byId<HTMLInputElement>('case').checked,
      }),
    })
    const json = await res.json()
    if (json.error) {
      if (json.error === 'not-configured') {
        setStatus('No Sourcebot configured. Click ⚙ to connect.', true)
        void openSettings()
        return
      }
      setStatus(`Search failed: ${json.error}${json.detail ? ' — ' + json.detail : ''}`, true)
      return
    }
    renderResults(json.hits ?? [], json.totalMatches ?? null)
  } catch (err) {
    setStatus('Search failed: ' + String(err), true)
  }
}

function initSearch(): void {
  byId<HTMLFormElement>('search-form').addEventListener('submit', (e) => {
    e.preventDefault()
    void runSearch()
  })
}

// --- browse mode (full Sourcebot UI in an iframe) ---------------------------

function initBrowse(): void {
  byId('browse-btn').addEventListener('click', async () => {
    const cfg = await refreshStatusLine()
    if (!cfg.configured) return
    const frame = byId<HTMLIFrameElement>('browse')
    if (frame.classList.contains('hidden')) {
      // Point the iframe at our same-origin reverse-proxy of Sourcebot's UI.
      if (!frame.src) frame.src = BASE + 'sb/'
      frame.classList.remove('hidden')
      byId('results').classList.add('hidden')
      byId('browse-btn').textContent = 'Search'
    } else {
      frame.classList.add('hidden')
      byId('results').classList.remove('hidden')
      byId('browse-btn').textContent = 'Browse'
    }
  })
}

// --- boot -------------------------------------------------------------------

async function main(): Promise<void> {
  await initTheme()
  initSettings()
  initSearch()
  initBrowse()
  await refreshStatusLine()
  byId<HTMLInputElement>('query').focus()
}

void main()
