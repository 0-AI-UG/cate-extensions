// =============================================================================
// SQLite reader — the viewer's data layer, backed by sql.js (SQLite compiled to
// WASM). No external `sqlite`/`datasette` install and no native module: the
// engine ships inside the artifact (dist/sql-wasm.wasm), so the same code runs
// on any Node ≥ 18, local or remote.
//
// A file is loaded fully into memory (sql.js has no incremental file backend),
// so we cache the opened Database per absolute path keyed on the file's mtime —
// pagination over one table reuses the load, and a changed file (or a Rescan)
// transparently reloads. Everything here is READ-ONLY: the in-memory copy is
// never written back, and the query endpoint is gated to read-only statements
// (isReadOnlySql) so the UI can't imply a write it won't perform.
//
// The pure helpers (clampLimit/clampOffset/quoteIdent/isReadOnlySql) carry the
// safety-critical logic and are unit-tested in db.test.ts.
// =============================================================================

import fs from 'fs'
import path from 'path'
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js'

// --- pure helpers (tested) -----------------------------------------------------

/** Clamp a client-supplied row limit into [1, max]; non-numeric falls back to
 *  `def`. Keeps a single page bounded regardless of what the panel requests. */
export function clampLimit(raw: unknown, def = 100, max = 1000): number {
  const n = Math.floor(Number(raw))
  if (!Number.isFinite(n) || n <= 0) return def
  return Math.min(n, max)
}

/** Clamp a client-supplied offset to a non-negative integer (0 on garbage). */
export function clampOffset(raw: unknown): number {
  const n = Math.floor(Number(raw))
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** SQLite identifier quoting: wrap in double quotes, doubling any embedded
 *  quote. Table/column names are also whitelisted against the live schema
 *  before use, but quoting keeps odd-but-legal names ("weird name", reserved
 *  words) working and is defence-in-depth against interpolation. */
export function quoteIdent(name: string): string {
  return '"' + String(name).replace(/"/g, '""') + '"'
}

// Statement kinds that only read. Anything else (INSERT/UPDATE/DELETE/DROP/
// ALTER/CREATE/ATTACH/…) is rejected before it reaches the engine.
const READ_ONLY_LEADERS = new Set(['select', 'with', 'explain', 'pragma', 'values'])

/** Strip SQL line (`-- …`) and block (`/* … *\/`) comments so the leading
 *  keyword check can't be fooled by a comment before the real statement. */
function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ')
}

/**
 * True when `sql` is safe to run against a database the user only means to
 * read: every non-empty `;`-separated statement must begin with a read-only
 * leader keyword. Conservative by design — a statement it can't confidently
 * classify as read-only is rejected. (sql.js loads a private in-memory copy so
 * a write could never touch the file on disk anyway; this keeps the UI honest.)
 */
export function isReadOnlySql(sql: string): boolean {
  const cleaned = stripSqlComments(sql)
  const statements = cleaned.split(';').map((s) => s.trim()).filter(Boolean)
  if (statements.length === 0) return false
  return statements.every((stmt) => {
    const leader = stmt.match(/^[a-z]+/i)?.[0].toLowerCase()
    return leader != null && READ_ONLY_LEADERS.has(leader)
  })
}

// --- engine loading + per-file cache -------------------------------------------

export interface TableInfo {
  name: string
  type: 'table' | 'view'
}

export interface ColumnInfo {
  name: string
  type: string
  pk: boolean
}

export interface TablePage {
  columns: ColumnInfo[]
  rows: unknown[][]
  total: number
  limit: number
  offset: number
  orderBy: string | null
  dir: 'asc' | 'desc'
}

export interface QueryResult {
  columns: string[]
  rows: unknown[][]
  truncated: boolean
}

let sqlPromise: Promise<SqlJsStatic> | null = null

/** Initialise sql.js once. `locateFile` points at the WASM copied next to the
 *  bundled server (copy-static.mjs), so no network/CDN fetch is attempted. */
function getSql(): Promise<SqlJsStatic> {
  if (!sqlPromise) {
    sqlPromise = initSqlJs({ locateFile: () => path.join(__dirname, 'sql-wasm.wasm') })
  }
  return sqlPromise
}

interface CachedDb {
  db: Database
  mtimeMs: number
}

const cache = new Map<string, CachedDb>()

/** Open (or reuse) the database at `absPath`. Reloads when the file's mtime has
 *  changed since the cached copy was read. */
async function openDb(absPath: string): Promise<Database> {
  const stat = fs.statSync(absPath)
  const cached = cache.get(absPath)
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.db
  if (cached) {
    try {
      cached.db.close()
    } catch {
      /* already closed */
    }
    cache.delete(absPath)
  }
  const SQL = await getSql()
  const bytes = fs.readFileSync(absPath)
  const db = new SQL.Database(bytes)
  cache.set(absPath, { db, mtimeMs: stat.mtimeMs })
  return db
}

/** Drop every cached database (Rescan / restart), freeing the in-memory copies. */
export function clearCache(): void {
  for (const { db } of cache.values()) {
    try {
      db.close()
    } catch {
      /* already closed */
    }
  }
  cache.clear()
}

// --- BLOB-safe value normalisation ---------------------------------------------

/** sql.js yields JS numbers/strings/null for scalars and Uint8Array for BLOBs.
 *  BLOBs aren't JSON-friendly (and dumping raw bytes into a grid is useless), so
 *  replace them with a compact human label; everything else passes through. */
function normalizeValue(v: unknown): unknown {
  if (v instanceof Uint8Array) return `⟨blob ${v.length} bytes⟩`
  return v
}

function normalizeRow(row: unknown[]): unknown[] {
  return row.map(normalizeValue)
}

// --- read operations -----------------------------------------------------------

/** All user tables and views in the database (system `sqlite_*` tables hidden),
 *  ordered tables-then-views, then by name. */
export async function listTables(absPath: string): Promise<TableInfo[]> {
  const db = await openDb(absPath)
  const res = db.exec(
    "SELECT name, type FROM sqlite_master " +
      "WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' " +
      'ORDER BY type = \'view\', name',
  )
  if (res.length === 0) return []
  return res[0].values.map((row) => ({ name: String(row[0]), type: row[1] as 'table' | 'view' }))
}

/** Column metadata for `table` via PRAGMA table_info. */
async function columnsOf(db: Database, table: string): Promise<ColumnInfo[]> {
  const res = db.exec(`PRAGMA table_info(${quoteIdent(table)})`)
  if (res.length === 0) return []
  // table_info columns: cid, name, type, notnull, dflt_value, pk
  return res[0].values.map((row) => ({
    name: String(row[1]),
    type: String(row[2] ?? ''),
    pk: Number(row[5]) > 0,
  }))
}

export interface ReadTableOptions {
  limit?: unknown
  offset?: unknown
  orderBy?: string | null
  dir?: string | null
}

/**
 * One bounded page of `table`. `table` and `orderBy` are validated against the
 * live schema (unknown names throw) and quoted, so the interpolated SQL is safe;
 * limit/offset are clamped integers.
 */
export async function readTable(absPath: string, table: string, opts: ReadTableOptions = {}): Promise<TablePage> {
  const db = await openDb(absPath)

  const tables = await listTables(absPath)
  if (!tables.some((t) => t.name === table)) {
    throw new Error(`Unknown table: ${table}`)
  }

  const columns = await columnsOf(db, table)
  const limit = clampLimit(opts.limit)
  const offset = clampOffset(opts.offset)

  // ORDER BY only by a real column of this table; direction is a hard enum.
  let orderBy: string | null = null
  if (opts.orderBy && columns.some((c) => c.name === opts.orderBy)) orderBy = opts.orderBy
  const dir: 'asc' | 'desc' = String(opts.dir).toLowerCase() === 'desc' ? 'desc' : 'asc'

  const countRes = db.exec(`SELECT count(*) FROM ${quoteIdent(table)}`)
  const total = countRes.length ? Number(countRes[0].values[0][0]) : 0

  const orderClause = orderBy ? ` ORDER BY ${quoteIdent(orderBy)} ${dir.toUpperCase()}` : ''
  const rowsRes = db.exec(
    `SELECT * FROM ${quoteIdent(table)}${orderClause} LIMIT ${limit} OFFSET ${offset}`,
  )
  const rows = rowsRes.length ? rowsRes[0].values.map(normalizeRow) : []

  return { columns, rows, total, limit, offset, orderBy, dir }
}

const QUERY_ROW_CAP = 1000

/**
 * Run a read-only SQL statement against the database and return the (capped)
 * result grid. Throws on a non-read-only statement or a SQL error (the caller
 * surfaces the message). Only the first result set is returned.
 */
export async function runQuery(absPath: string, sql: string): Promise<QueryResult> {
  if (!isReadOnlySql(sql)) {
    throw new Error('Only read-only statements (SELECT / WITH / EXPLAIN / PRAGMA) are allowed.')
  }
  const db = await openDb(absPath)
  const res = db.exec(sql)
  if (res.length === 0) return { columns: [], rows: [], truncated: false }
  const first = res[0]
  const truncated = first.values.length > QUERY_ROW_CAP
  const values = truncated ? first.values.slice(0, QUERY_ROW_CAP) : first.values
  return { columns: first.columns, rows: values.map(normalizeRow), truncated }
}
