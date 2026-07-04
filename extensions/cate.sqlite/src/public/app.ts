// SQLite viewer panel. External script (CSP-safe, no inline JS). It:
//   - themes the chrome from cate.theme.get() via the shared kit
//   - lists the workspace databases + their tables/views (GET /api/databases)
//   - shows a bounded, sortable page of any table (GET /api/table) that grows
//     via a "Load more" row at the bottom of the scrolled grid (with a
//     chunk-size select); no footer bar, no pagination chrome
//   - runs read-only SQL against a database (POST /api/query); the SQL toggle
//     lives in the sidebar head
//   - re-detects databases automatically (POST /api/rescan on panel focus and
//     every 60s while visible; the sidebar updates in place and the open table
//     is never reloaded under the reader)
//
// The sidebar is collapsible (agent-panel idiom): a sidebar-glyph toggle in
// its head collapses it to a slim rail holding the same toggle.
//
// All fetch URLs are relative so they resolve under /ext/<routeToken>/ and
// tunnel through Cate's proxy, which injects the bearer; the page never holds a
// token. Data is rendered with textContent only (no innerHTML for values).

import '../_kit/cate-kit.css'
import './style.css'
import { initTheme } from '../_kit/theme'
import { apiFetch } from '../_kit/api-client'

interface TableRef {
  name: string
  type: 'table' | 'view'
}
interface DbRow {
  name: string
  relPath: string
  size: number
  tables: TableRef[]
  error?: string
}
interface ColumnInfo {
  name: string
  type: string
  pk: boolean
}
interface TablePage {
  db: string
  table: string
  columns: ColumnInfo[]
  rows: unknown[][]
  total: number
  limit: number
  offset: number
  orderBy: string | null
  dir: 'asc' | 'desc'
}

const CLOSE_ICON =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
// Sidebar toggle glyph (agent-panel idiom: rect with a left-column divider).
const SIDEBAR_ICON =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="1.75" y="3" width="12.5" height="10" rx="1.5"/><path d="M6 3v10"/></svg>'

const SELECTION_KEY = 'selection'
const CHUNK_SIZES = [25, 100, 500]
const RESCAN_INTERVAL_MS = 60_000

// --- tiny DOM helpers ----------------------------------------------------------

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

function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild)
}

function iconButton(svg: string, label: string): HTMLButtonElement {
  const btn = el('button', 'cate-iconbtn') as HTMLButtonElement
  btn.type = 'button'
  btn.setAttribute('aria-label', label)
  btn.title = label
  const tpl = document.createElement('template')
  tpl.innerHTML = svg.trim() // static, trusted SVG constant
  const svgNode = tpl.content.firstChild
  if (svgNode) btn.appendChild(svgNode)
  else btn.textContent = '↻'
  return btn
}

// --- state ---------------------------------------------------------------------

let databases: DbRow[] = []
let selection: { db: string; table: string } | null = null
/** The open table with rows ACCUMULATED across "Load more" chunks. */
let current: TablePage | null = null
/** Chunk size for the next load (initial page and each "Load more"). */
let chunk = 100
let queryOpen = false

// DOM roots (built once in mount()).
let dbListEl: HTMLElement
let gridWrapEl: HTMLElement
let queryToggleBtn: HTMLButtonElement
let queryPanelEl: HTMLElement

// --- API -----------------------------------------------------------------------

async function api<T>(pathAndQuery: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(pathAndQuery, {
    ...init,
    headers: { accept: 'application/json', ...(init?.headers || {}) },
  })
  const body = (await res.json()) as T & { error?: string }
  if (!res.ok || (body && body.error)) {
    throw new Error(body?.error || `Request failed (${res.status})`)
  }
  return body
}

async function fetchChunk(
  offset: number,
  orderBy: string | null,
  dir: 'asc' | 'desc',
): Promise<TablePage> {
  if (!selection) throw new Error('No table selected')
  const params = new URLSearchParams({
    db: selection.db,
    table: selection.table,
    limit: String(chunk),
    offset: String(offset),
  })
  if (orderBy) {
    params.set('orderBy', orderBy)
    params.set('dir', dir)
  }
  return api<TablePage>('api/table?' + params.toString())
}

// --- rendering: sidebar --------------------------------------------------------

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function renderSidebar(): void {
  clear(dbListEl)
  if (databases.length === 0) {
    dbListEl.appendChild(el('div', 'sq-side-error', 'No databases'))
    return
  }
  for (const db of databases) {
    const wrap = el('div', 'sq-db')
    const head = el('div', 'sq-db-name')
    head.appendChild(el('span', 'sq-db-label', db.name)).title = db.relPath
    head.appendChild(el('span', 'sq-db-size', formatSize(db.size)))
    wrap.appendChild(head)

    if (db.error) {
      wrap.appendChild(el('div', 'sq-side-error', db.error))
    }
    for (const t of db.tables) {
      const item = el('button', 'sq-table-item') as HTMLButtonElement
      item.type = 'button'
      item.appendChild(el('span', 'sq-table-label', t.name))
      if (t.type === 'view') item.appendChild(el('span', 'sq-badge', 'view'))
      if (selection && selection.db === db.relPath && selection.table === t.name) {
        item.classList.add('is-active')
      }
      item.addEventListener('click', () => void selectTable(db.relPath, t.name))
      wrap.appendChild(item)
    }
    dbListEl.appendChild(wrap)
  }
}

// --- rendering: data grid ------------------------------------------------------

function valueCell(v: unknown): HTMLTableCellElement {
  const td = el('td')
  if (v === null || v === undefined) {
    td.appendChild(el('span', 'sq-null', 'NULL'))
  } else {
    const text = String(v)
    td.textContent = text
    if (text.length > 40) td.title = text
  }
  return td
}

/** A grid with optional sortable headers (table view passes column meta + a
 *  sort click handler; the query view passes plain string headers). */
function buildGrid(
  columns: Array<{ name: string; type?: string; pk?: boolean }>,
  rows: unknown[][],
  sort?: { by: string | null; dir: 'asc' | 'desc'; onSort: (col: string) => void },
): HTMLTableElement {
  const table = el('table', 'sq-grid')
  const thead = el('thead')
  const htr = el('tr')
  for (const col of columns) {
    const th = el('th')
    th.appendChild(document.createTextNode(col.name))
    if (col.pk) th.appendChild(el('span', 'sq-pk', '⚿')) // key glyph
    if (col.type) th.appendChild(el('span', 'sq-coltype', col.type))
    if (sort) {
      if (sort.by === col.name) {
        th.appendChild(el('span', 'sq-sort', sort.dir === 'asc' ? '↑' : '↓'))
      }
      th.addEventListener('click', () => sort.onSort(col.name))
    } else {
      th.style.cursor = 'default'
    }
    htr.appendChild(th)
  }
  thead.appendChild(htr)
  table.appendChild(thead)

  const tbody = el('tbody')
  for (const row of rows) {
    const tr = el('tr')
    for (const v of row) tr.appendChild(valueCell(v))
    tbody.appendChild(tr)
  }
  table.appendChild(tbody)
  return table
}

/** End-of-grid row: loaded count, and (while more rows exist) a chunk-size
 *  select + "Load more" button. Lives INSIDE the scroll container, so it is
 *  reached by scrolling to the bottom. */
function buildLoadMoreRow(): HTMLElement {
  const row = el('div', 'sq-loadmore')
  if (!current) return row
  const loaded = current.rows.length
  const label =
    loaded < current.total
      ? `${current.table} · ${loaded} of ${current.total} rows`
      : `${current.table} · ${current.total} row${current.total === 1 ? '' : 's'}`
  row.appendChild(el('span', 'sq-loadmore__count', label))

  if (loaded < current.total) {
    const sel = el('select', 'cate-select sq-select') as HTMLSelectElement
    sel.setAttribute('aria-label', 'Rows to load')
    sel.title = 'Rows to load'
    for (const s of CHUNK_SIZES) {
      const opt = el('option', undefined, String(s)) as HTMLOptionElement
      opt.value = String(s)
      if (s === chunk) opt.selected = true
      sel.appendChild(opt)
    }
    sel.addEventListener('change', () => {
      chunk = Number(sel.value) || 100
    })

    const more = el('button', 'sq-btn', 'Load more') as HTMLButtonElement
    more.type = 'button'
    more.addEventListener('click', () => {
      more.disabled = true
      void loadMore().finally(() => {
        more.disabled = false
      })
    })
    row.append(sel, more)
  }
  return row
}

function renderTable(): void {
  clear(gridWrapEl)
  if (!current) return
  const grid = buildGrid(current.columns, current.rows, {
    by: current.orderBy,
    dir: current.dir,
    onSort: (col) => void toggleSort(col),
  })
  gridWrapEl.append(grid, buildLoadMoreRow())
}

// --- actions -------------------------------------------------------------------

/** Reconcile a fresh database list into the UI: redraw the sidebar, drop a
 *  selection that no longer exists (falling back to the first table), but do
 *  NOT reload the open table — background rescans must never yank the grid
 *  out from under the reader. */
async function applyDatabases(found: DbRow[]): Promise<void> {
  databases = found
  if (
    selection &&
    !databases.some(
      (d) => d.relPath === selection!.db && d.tables.some((t) => t.name === selection!.table),
    )
  ) {
    selection = null
    current = null
  }
  renderSidebar()
  // Selection intact: nothing else to touch (selectTable re-renders the query
  // panel on change; rebuilding it here would wipe SQL mid-typing on a
  // background rescan).
  if (selection) return
  const firstDb = databases.find((d) => d.tables.length > 0)
  if (firstDb) await selectTable(firstDb.relPath, firstDb.tables[0].name)
  else showEmptyMain()
}

async function loadDatabases(): Promise<void> {
  const data = await api<{ databases: DbRow[] }>('api/databases')
  await applyDatabases(data.databases || [])
}

/** Re-detect workspace databases. Runs silently on focus/interval; `manual`
 *  (the empty state's "Check again") also reports the outcome inline. */
let scanning = false
async function refreshDatabases(manual: boolean, report?: (msg: string) => void): Promise<void> {
  if (scanning) return
  scanning = true
  try {
    const data = await api<{ databases: DbRow[] }>('api/rescan', { method: 'POST' })
    await applyDatabases(data.databases || [])
    if (manual) {
      report?.(`Found ${databases.length} database${databases.length === 1 ? '' : 's'}`)
    }
  } catch {
    if (manual) report?.('Rescan failed')
  } finally {
    scanning = false
  }
}

function showEmptyMain(): void {
  clear(gridWrapEl)
  const empty = el('div', 'sq-empty')
  empty.appendChild(el('strong', undefined, 'No SQLite databases found'))
  empty.appendChild(
    document.createTextNode(
      'Add a .db / .sqlite / .sqlite3 file to this workspace — it is picked up automatically.',
    ),
  )
  const check = el('button', 'sq-btn sq-empty-btn', 'Check again') as HTMLButtonElement
  check.type = 'button'
  const note = el('div', 'sq-empty-note')
  check.addEventListener('click', () => {
    check.disabled = true
    void refreshDatabases(true, (msg) => {
      note.textContent = msg
    }).finally(() => {
      check.disabled = false
    })
  })
  empty.append(check, note)
  gridWrapEl.appendChild(empty)
  queryToggleBtn.disabled = true
}

async function selectTable(db: string, table: string): Promise<void> {
  selection = { db, table }
  queryToggleBtn.disabled = false
  rememberSelection()
  renderSidebar()
  renderQueryPanel()
  await loadTable(null, 'asc')
}

/** (Re)load the first chunk — on table select and on sort changes. */
async function loadTable(orderBy: string | null, dir: 'asc' | 'desc'): Promise<void> {
  if (!selection) return
  try {
    current = await fetchChunk(0, orderBy, dir)
    renderTable()
    gridWrapEl.scrollTop = 0
  } catch (err) {
    clear(gridWrapEl)
    gridWrapEl.appendChild(el('div', 'sq-empty', err instanceof Error ? err.message : String(err)))
  }
}

/** Append the next chunk, preserving the reader's scroll position. */
async function loadMore(): Promise<void> {
  if (!selection || !current) return
  try {
    const page = await fetchChunk(current.rows.length, current.orderBy, current.dir)
    current.rows.push(...page.rows)
    current.total = page.total
    const scrollTop = gridWrapEl.scrollTop
    renderTable()
    gridWrapEl.scrollTop = scrollTop
  } catch (err) {
    clear(gridWrapEl)
    gridWrapEl.appendChild(el('div', 'sq-empty', err instanceof Error ? err.message : String(err)))
  }
}

function toggleSort(col: string): void {
  if (!current) return
  let orderBy: string | null = col
  let dir: 'asc' | 'desc' = 'asc'
  if (current.orderBy === col) {
    if (current.dir === 'asc') dir = 'desc'
    else orderBy = null // asc -> desc -> unsorted
  }
  void loadTable(orderBy, dir)
}

// --- query panel ---------------------------------------------------------------

function renderQueryPanel(): void {
  clear(queryPanelEl)
  queryPanelEl.hidden = !queryOpen
  if (!queryOpen || !selection) return

  // Scrim: click outside the modal to dismiss.
  const scrim = el('div', 'sq-scrim')
  scrim.addEventListener('click', () => closeQuery())

  const modal = el('div', 'sq-modal')
  modal.setAttribute('role', 'dialog')
  modal.setAttribute('aria-label', 'Run SQL')

  const head = el('div', 'sq-modal-head')
  head.appendChild(el('span', 'sq-modal-title', 'Run SQL'))
  head.appendChild(el('span', 'sq-modal-db', selection.db)).title = selection.db
  head.appendChild(el('span', 'sq-modal-spacer'))
  const closeBtn = iconButton(CLOSE_ICON, 'Close')
  closeBtn.addEventListener('click', () => closeQuery())
  head.appendChild(closeBtn)

  const body = el('div', 'sq-modal-body')
  const ta = el('textarea', 'sq-query-input') as HTMLTextAreaElement
  ta.placeholder = `SELECT * FROM ... — read-only query against ${selection.db}`
  ta.spellcheck = false

  const runBtn = el('button', 'sq-btn', 'Run') as HTMLButtonElement
  runBtn.type = 'button'

  const hint = el('span', 'sq-query-hint', 'Read-only: SELECT / WITH / EXPLAIN / PRAGMA. ⌘↩ to run.')
  const actions = el('div', 'sq-query-actions')
  actions.append(runBtn, hint)

  const errorEl = el('div', 'sq-query-error')
  errorEl.hidden = true
  const resultEl = el('div', 'sq-query-result')
  resultEl.hidden = true

  const run = async (): Promise<void> => {
    const sql = ta.value.trim()
    if (!sql || !selection) return
    runBtn.disabled = true
    errorEl.hidden = true
    try {
      const res = await api<{ columns: string[]; rows: unknown[][]; truncated: boolean }>('api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ db: selection.db, sql }),
      })
      clear(resultEl)
      resultEl.appendChild(buildGrid(res.columns.map((name) => ({ name })), res.rows))
      if (res.truncated) {
        resultEl.appendChild(el('div', 'sq-query-hint', 'Showing the first 1000 rows.'))
      }
      resultEl.hidden = false
    } catch (err) {
      errorEl.textContent = err instanceof Error ? err.message : String(err)
      errorEl.hidden = false
      resultEl.hidden = true
    } finally {
      runBtn.disabled = false
    }
  }

  runBtn.addEventListener('click', () => void run())
  ta.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      void run()
    }
  })

  body.append(ta, actions, errorEl, resultEl)
  modal.append(head, body)
  queryPanelEl.append(scrim, modal)
  ta.focus()
}

function toggleQuery(): void {
  if (queryOpen) closeQuery()
  else openQuery()
}

function openQuery(): void {
  if (!selection) return
  queryOpen = true
  queryToggleBtn.classList.add('is-on')
  renderQueryPanel()
}

function closeQuery(): void {
  queryOpen = false
  queryToggleBtn.classList.remove('is-on')
  renderQueryPanel()
}

// --- persistence ----------------------------------------------------------------

function rememberSelection(): void {
  try {
    void cate?.storage.panel.set(SELECTION_KEY, selection)
  } catch {
    /* best-effort UI state */
  }
}

async function restoreSelection(): Promise<void> {
  try {
    const saved = (await cate?.storage.panel.get(SELECTION_KEY)) as { db: string; table: string } | null
    if (saved && typeof saved.db === 'string' && typeof saved.table === 'string') selection = saved
  } catch {
    /* ignore */
  }
}

// --- mount ----------------------------------------------------------------------

function mount(root: HTMLElement): void {
  clear(root)
  const app = el('div', 'sq-root')

  // Collapsed-sidebar rail: just the reopen toggle (agent-panel idiom).
  const rail = el('div', 'sq-rail')
  rail.hidden = true
  const railToggle = iconButton(SIDEBAR_ICON, 'Open sidebar')
  rail.appendChild(railToggle)

  // Sidebar: head (collapse toggle + SQL) above the database/table list.
  const side = el('aside', 'sq-side')
  const sideHead = el('div', 'sq-side__head')
  const sideToggle = iconButton(SIDEBAR_ICON, 'Collapse sidebar')
  queryToggleBtn = el('button', 'cate-btn sq-sql-btn', 'SQL') as HTMLButtonElement
  queryToggleBtn.type = 'button'
  queryToggleBtn.title = 'Run read-only SQL'
  queryToggleBtn.addEventListener('click', () => toggleQuery())
  sideHead.append(sideToggle, el('span', 'sq-side__spacer'), queryToggleBtn)
  dbListEl = el('div', 'sq-db-list')
  side.append(sideHead, dbListEl)

  const setSidebarOpen = (open: boolean): void => {
    side.hidden = !open
    rail.hidden = open
  }
  sideToggle.addEventListener('click', () => setSidebarOpen(false))
  railToggle.addEventListener('click', () => setSidebarOpen(true))

  // Main pane: just the grid; the "Load more" row lives at the end of the
  // scrolled content.
  const main = el('main', 'sq-main')
  gridWrapEl = el('div', 'sq-grid-wrap')

  // The SQL runner lives in a modal overlay, mounted at the app root so it
  // floats above the whole panel. Escape dismisses it.
  queryPanelEl = el('div', 'sq-query-overlay')
  queryPanelEl.hidden = true
  queryPanelEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      closeQuery()
    }
  })

  main.append(gridWrapEl)
  app.append(rail, side, main, queryPanelEl)
  root.appendChild(app)
}

async function boot(): Promise<void> {
  await initTheme()
  mount(document.getElementById('root')!)
  await restoreSelection()
  try {
    await loadDatabases()
  } catch (err) {
    clear(gridWrapEl)
    gridWrapEl.appendChild(
      el('div', 'sq-empty', err instanceof Error ? err.message : String(err)),
    )
  }
  // `cate` is an undeclared global outside Cate; `?.` alone doesn't guard that.
  if (typeof cate !== 'undefined') cate?.panel.setTitle('SQLite').catch(() => {})
}

// New databases appear without manual chrome: re-detect when the panel becomes
// visible and on a slow interval while it stays visible.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void refreshDatabases(false)
})
setInterval(() => {
  if (document.visibilityState === 'visible') void refreshDatabases(false)
}, RESCAN_INTERVAL_MS)

void boot()
