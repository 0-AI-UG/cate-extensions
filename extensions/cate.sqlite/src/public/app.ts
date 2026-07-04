// SQLite viewer panel. External script (CSP-safe, no inline JS). It:
//   - themes the chrome from cate.theme.get() via the shared kit
//   - lists the workspace databases + their tables/views (GET /api/databases)
//   - shows a bounded, sortable, paginated page of any table (GET /api/table)
//   - runs read-only SQL against a database (POST /api/query)
//   - rescans the workspace on demand (POST /api/rescan)
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

const RESCAN_ICON =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M13.7 1.8v2.8h-2.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'

const CLOSE_ICON =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'

const SELECTION_KEY = 'selection'
const PAGE_SIZES = [25, 100, 500]

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
  const btn = el('button', 'sq-icon-btn') as HTMLButtonElement
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
let current: TablePage | null = null
let limit = 100
let queryOpen = false

// DOM roots (built once in mount()).
let dbListEl: HTMLElement
let titleEl: HTMLElement
let countEl: HTMLElement
let gridWrapEl: HTMLElement
let pagerEl: HTMLElement
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

function renderTablePage(): void {
  clear(gridWrapEl)
  clear(pagerEl)
  if (!current) return

  const grid = buildGrid(current.columns, current.rows, {
    by: current.orderBy,
    dir: current.dir,
    onSort: (col) => void toggleSort(col),
  })
  gridWrapEl.appendChild(grid)

  titleEl.textContent = current.table
  const from = current.total === 0 ? 0 : current.offset + 1
  const to = Math.min(current.offset + current.limit, current.total)
  countEl.textContent = `${from}–${to} of ${current.total}`

  // Pager.
  const prev = el('button', 'sq-btn', 'Prev') as HTMLButtonElement
  prev.type = 'button'
  prev.disabled = current.offset <= 0
  prev.addEventListener('click', () => void loadPage(Math.max(0, current!.offset - current!.limit)))

  const next = el('button', 'sq-btn', 'Next') as HTMLButtonElement
  next.type = 'button'
  next.disabled = to >= current.total
  next.addEventListener('click', () => void loadPage(current!.offset + current!.limit))

  const sizeSel = el('select') as HTMLSelectElement
  for (const s of PAGE_SIZES) {
    const opt = el('option', undefined, String(s)) as HTMLOptionElement
    opt.value = String(s)
    if (s === limit) opt.selected = true
    sizeSel.appendChild(opt)
  }
  sizeSel.addEventListener('change', () => {
    limit = Number(sizeSel.value) || 100
    void loadPage(0)
  })

  pagerEl.append(prev, next, el('span', undefined, 'rows per page:'), sizeSel)
}

// --- actions -------------------------------------------------------------------

async function loadDatabases(): Promise<void> {
  const data = await api<{ databases: DbRow[] }>('api/databases')
  databases = data.databases || []
  // Keep the selection if it still exists; otherwise fall back to the first table.
  if (selection && !databases.some((d) => d.relPath === selection!.db && d.tables.some((t) => t.name === selection!.table))) {
    selection = null
    current = null
  }
  renderSidebar()
  if (!selection) {
    const firstDb = databases.find((d) => d.tables.length > 0)
    if (firstDb) {
      await selectTable(firstDb.relPath, firstDb.tables[0].name)
      return
    }
    showEmptyMain()
  } else {
    renderQueryPanel()
  }
}

function showEmptyMain(): void {
  clear(gridWrapEl)
  clear(pagerEl)
  titleEl.textContent = ''
  countEl.textContent = ''
  const empty = el('div', 'sq-empty')
  empty.appendChild(el('strong', undefined, 'No SQLite databases found'))
  empty.appendChild(
    document.createTextNode(
      'Add a .db / .sqlite / .sqlite3 file to this workspace and press Rescan.',
    ),
  )
  gridWrapEl.appendChild(empty)
  queryToggleBtn.disabled = true
}

async function selectTable(db: string, table: string): Promise<void> {
  selection = { db, table }
  limit = limit || 100
  queryToggleBtn.disabled = false
  rememberSelection()
  renderSidebar()
  renderQueryPanel()
  await loadPage(0, /*asc*/ null, 'asc')
}

async function loadPage(offset: number, orderBy?: string | null, dir?: 'asc' | 'desc'): Promise<void> {
  if (!selection) return
  const params = new URLSearchParams({
    db: selection.db,
    table: selection.table,
    limit: String(limit),
    offset: String(offset),
  })
  // Preserve the current sort unless the caller overrides it.
  const ob = orderBy !== undefined ? orderBy : current?.orderBy ?? null
  const d = dir ?? current?.dir ?? 'asc'
  if (ob) {
    params.set('orderBy', ob)
    params.set('dir', d)
  }
  try {
    current = await api<TablePage>('api/table?' + params.toString())
    renderTablePage()
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
  void loadPage(0, orderBy, dir)
}

async function rescan(): Promise<void> {
  const data = await api<{ databases: DbRow[] }>('api/rescan', { method: 'POST' })
  databases = data.databases || []
  if (selection && !databases.some((d) => d.relPath === selection!.db && d.tables.some((t) => t.name === selection!.table))) {
    selection = null
    current = null
  }
  renderSidebar()
  if (selection) await loadPage(current?.offset ?? 0)
  else if (databases.some((d) => d.tables.length > 0)) await loadDatabases()
  else showEmptyMain()
  cate?.ui.notify(`Found ${databases.length} database${databases.length === 1 ? '' : 's'}.`, 'info').catch(() => {})
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

  // Sidebar.
  const side = el('aside', 'sq-side')
  const sideHead = el('div', 'sq-side-head')
  sideHead.appendChild(el('span', undefined, 'Databases'))
  const rescanBtn = iconButton(RESCAN_ICON, 'Rescan workspace for SQLite files')
  rescanBtn.addEventListener('click', () => {
    rescanBtn.disabled = true
    void rescan().finally(() => {
      rescanBtn.disabled = false
    })
  })
  sideHead.appendChild(rescanBtn)
  dbListEl = el('div', 'sq-db-list')
  side.append(sideHead, dbListEl)

  // Main pane.
  const main = el('main', 'sq-main')
  const toolbar = el('div', 'sq-toolbar')
  titleEl = el('span', 'sq-title')
  countEl = el('span', 'sq-count')
  const spacer = el('span', 'sq-toolbar-spacer')
  queryToggleBtn = el('button', 'sq-btn', 'SQL') as HTMLButtonElement
  queryToggleBtn.type = 'button'
  queryToggleBtn.addEventListener('click', () => toggleQuery())
  toolbar.append(titleEl, countEl, spacer, queryToggleBtn)

  gridWrapEl = el('div', 'sq-grid-wrap')
  pagerEl = el('div', 'sq-pager')

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

  main.append(toolbar, gridWrapEl, pagerEl)
  app.append(side, main, queryPanelEl)
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
  cate?.panel.setTitle('SQLite').catch(() => {})
}

void boot()
