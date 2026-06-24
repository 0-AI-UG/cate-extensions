// Sourcebot panel. External script only (CSP-safe). All fetch/iframe URLs are
// relative so they resolve under /ext/<routeToken>/ and tunnel through Cate's
// proxy (which injects the per-server bearer). The page never holds a token.
//
// The shared ServiceConnection widget owns the connect/error/ready gating; this
// connects to a Sourcebot instance the USER runs (base URL + optional API key,
// stored via cate.storage so the server can read it back over CATE_API). Once
// ready it mounts the native code-search UI into the widget's content area:
//   - Native search: POST ./sbapi/search, render flat hits, and on click call
//     cate.editor.openFile(path, { line }) to open the hit in a Cate editor.
//   - Browse: load the full Sourcebot UI in an iframe pointed at ./sb/ (the
//     server reverse-proxies it same-origin).

import '../_kit/cate-kit.css'
import './style.css'
import { initTheme } from '../_kit/theme'
import { ServiceConnection } from '../_kit/service-connection'

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

interface ConfigStatus {
  configured: boolean
  baseUrl?: string
  hasKey?: boolean
  reachable?: boolean
  probeStatus?: number
  probeError?: string
  error?: string
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

// --- config -----------------------------------------------------------------

async function fetchConfig(): Promise<ConfigStatus> {
  const res = await fetch(BASE + 'api/config')
  return (await res.json()) as ConfigStatus
}

// --- the connection widget ---------------------------------------------------

const conn = new ServiceConnection(document.getElementById('root')!, {
  serviceName: 'Sourcebot',
  description:
    'Connect to a self-hosted Sourcebot instance you run yourself (Cate does not bundle Sourcebot — its license forbids redistribution).',
  connect: {
    urlLabel: 'Sourcebot URL',
    urlPlaceholder: 'https://sourcebot.internal.example.com',
    apiKey: true,
    apiKeyLabel: 'API key (optional)',
    help: 'The optional API key (X-Sourcebot-Api-Key) is stored by Cate and injected server-side; the panel never holds it.',
    onSubmit: (v) => void submitConnection(v),
  },
  onRetry: () => void recheck(),
  onReady: (mount) => buildSearchUI(mount),
})

/** Apply a ConfigStatus to the widget: ready / error / needs-connection. */
function applyConfig(cfg: ConfigStatus, opts?: { afterSubmit?: boolean }): void {
  if (!cfg.configured) {
    conn.setState({
      kind: 'needs-connection',
      message: opts?.afterSubmit ? 'The URL was rejected: ' + (cfg.error || 'invalid URL') : undefined,
    })
    return
  }
  if (cfg.reachable) {
    conn.setState({ kind: 'ready' })
    return
  }
  conn.setState({
    kind: 'error',
    message: `${cfg.baseUrl || 'Sourcebot'} is not reachable: ${cfg.probeError || 'no response'}.`,
    detail: 'Check the instance is running and the URL is correct.',
    canRetry: true,
  })
}

async function recheck(): Promise<void> {
  conn.setState({ kind: 'connecting' })
  let cfg: ConfigStatus
  try {
    cfg = await fetchConfig()
  } catch (err) {
    conn.setState({
      kind: 'error',
      message: 'Cannot reach the extension server.',
      detail: String(err),
      canRetry: true,
    })
    return
  }
  applyConfig(cfg)
}

async function submitConnection(v: { url: string; apiKey?: string }): Promise<void> {
  if (!window.cate) {
    conn.setState({
      kind: 'error',
      message: 'window.cate unavailable; cannot persist config.',
      canRetry: false,
    })
    return
  }
  conn.setState({ kind: 'connecting', message: 'Saving and testing…' })
  try {
    await cate.storage.set(KEY_BASE_URL, v.url)
    await cate.storage.set(KEY_API_KEY, v.apiKey || '')
    const cfg = await fetchConfig()
    applyConfig(cfg, { afterSubmit: true })
  } catch (err) {
    conn.setState({
      kind: 'error',
      message: 'Failed to save the connection.',
      detail: String(err),
      canRetry: true,
    })
  }
}

// --- native search UI (built once, into the widget's content area) -----------

let statusEl!: HTMLElement
let resultsEl!: HTMLElement
let browseFrame!: HTMLIFrameElement
let queryInput!: HTMLInputElement
let regexInput!: HTMLInputElement
let caseInput!: HTMLInputElement
let browseBtn!: HTMLButtonElement

function setStatus(text: string, isError = false): void {
  statusEl.textContent = text
  statusEl.classList.toggle('sb-status--error', isError)
}

function buildSearchUI(mount: HTMLElement): void {
  const app = el('div', 'sb-app')

  // --- top bar (search form + toggles + browse) ---
  const form = el('form', 'sb-form') as HTMLFormElement
  queryInput = el('input', 'cate-input sb-query') as HTMLInputElement
  queryInput.type = 'text'
  queryInput.autocomplete = 'off'
  queryInput.spellcheck = false
  queryInput.placeholder = 'Search code…  (repo:  lang:  file:  sym:)'

  const regexLabel = el('label', 'sb-toggle')
  regexInput = el('input') as HTMLInputElement
  regexInput.type = 'checkbox'
  regexLabel.appendChild(regexInput)
  regexLabel.appendChild(document.createTextNode(' .*'))

  const caseLabel = el('label', 'sb-toggle')
  caseInput = el('input') as HTMLInputElement
  caseInput.type = 'checkbox'
  caseLabel.appendChild(caseInput)
  caseLabel.appendChild(document.createTextNode(' Aa'))

  const searchBtn = el('button', 'cate-btn cate-btn--primary', 'Search') as HTMLButtonElement
  searchBtn.type = 'submit'

  browseBtn = el('button', 'cate-btn', 'Browse') as HTMLButtonElement
  browseBtn.type = 'button'
  browseBtn.title = 'Open the full Sourcebot web UI'

  form.append(queryInput, regexLabel, caseLabel, searchBtn, browseBtn)

  const bar = el('div', 'cate-topbar sb-bar')
  bar.appendChild(form)

  statusEl = el('div', 'sb-status')

  resultsEl = el('main', 'sb-results')

  browseFrame = el('iframe', 'sb-browse') as HTMLIFrameElement
  browseFrame.title = 'Sourcebot'
  browseFrame.hidden = true

  app.append(bar, statusEl, resultsEl, browseFrame)
  mount.appendChild(app)

  form.addEventListener('submit', (e) => {
    e.preventDefault()
    void runSearch()
  })
  browseBtn.addEventListener('click', () => toggleBrowse())

  queryInput.focus()
}

function renderResults(hits: SearchHit[], totalMatches: number | null): void {
  resultsEl.replaceChildren()
  if (hits.length === 0) {
    resultsEl.appendChild(el('div', 'cate-empty', 'No matches.'))
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
    const group = el('div', 'sb-repo')
    group.appendChild(el('div', 'sb-repo__head', repo || '(unknown repository)'))
    for (const hit of list) {
      const btn = el('button', 'sb-hit') as HTMLButtonElement
      btn.type = 'button'
      btn.appendChild(el('span', 'sb-hit__path', hit.path))
      btn.appendChild(el('span', 'sb-hit__line', ` : ${hit.line}`))
      if (hit.snippet) btn.appendChild(el('pre', 'sb-hit__snippet', hit.snippet))
      btn.addEventListener('click', () => void openHit(hit))
      group.appendChild(btn)
    }
    resultsEl.appendChild(group)
  }

  setStatus(
    totalMatches != null
      ? `${hits.length} shown · ${totalMatches} total matches`
      : `${hits.length} results`,
  )
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
  const query = queryInput.value.trim()
  if (!query) return
  // Leave browse mode if active.
  browseFrame.hidden = true
  resultsEl.hidden = false
  browseBtn.textContent = 'Browse'

  setStatus('Searching…')
  try {
    const res = await fetch(BASE + 'sbapi/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        matches: 50,
        isRegexEnabled: regexInput.checked,
        isCaseSensitivityEnabled: caseInput.checked,
      }),
    })
    const json = await res.json()
    if (json.error) {
      if (json.error === 'not-configured') {
        // Config was cleared underneath us; drop back to the connect form.
        conn.setState({ kind: 'needs-connection', message: 'No Sourcebot configured.' })
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

function toggleBrowse(): void {
  if (browseFrame.hidden) {
    // Point the iframe at our same-origin reverse-proxy of Sourcebot's UI.
    if (!browseFrame.src) browseFrame.src = BASE + 'sb/'
    browseFrame.hidden = false
    resultsEl.hidden = true
    browseBtn.textContent = 'Search'
  } else {
    browseFrame.hidden = true
    resultsEl.hidden = false
    browseBtn.textContent = 'Browse'
  }
}

// --- boot --------------------------------------------------------------------

async function boot(): Promise<void> {
  await initTheme()
  await recheck()
}

void boot()
