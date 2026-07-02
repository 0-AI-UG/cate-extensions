import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import initSqlJs from 'sql.js'
import {
  clampLimit,
  clampOffset,
  quoteIdent,
  isReadOnlySql,
  listTables,
  readTable,
  runQuery,
  clearCache,
} from './db'

// --- pure helpers --------------------------------------------------------------

describe('clampLimit', () => {
  it('defaults on garbage / non-positive', () => {
    expect(clampLimit(undefined)).toBe(100)
    expect(clampLimit('nope')).toBe(100)
    expect(clampLimit(0)).toBe(100)
    expect(clampLimit(-5)).toBe(100)
  })
  it('honours valid values and caps at max', () => {
    expect(clampLimit(25)).toBe(25)
    expect(clampLimit('50')).toBe(50)
    expect(clampLimit(999999)).toBe(1000)
  })
})

describe('clampOffset', () => {
  it('floors to a non-negative integer', () => {
    expect(clampOffset(undefined)).toBe(0)
    expect(clampOffset(-3)).toBe(0)
    expect(clampOffset('20')).toBe(20)
    expect(clampOffset(7.9)).toBe(7)
  })
})

describe('quoteIdent', () => {
  it('wraps in double quotes and doubles embedded quotes', () => {
    expect(quoteIdent('users')).toBe('"users"')
    expect(quoteIdent('weird name')).toBe('"weird name"')
    expect(quoteIdent('a"b')).toBe('"a""b"')
  })
})

describe('isReadOnlySql', () => {
  it('accepts read-only leaders', () => {
    expect(isReadOnlySql('SELECT * FROM t')).toBe(true)
    expect(isReadOnlySql('  with x as (select 1) select * from x')).toBe(true)
    expect(isReadOnlySql('EXPLAIN QUERY PLAN SELECT 1')).toBe(true)
    expect(isReadOnlySql('pragma table_info(t)')).toBe(true)
    expect(isReadOnlySql('VALUES (1),(2)')).toBe(true)
  })
  it('rejects writes and DDL', () => {
    expect(isReadOnlySql('DELETE FROM t')).toBe(false)
    expect(isReadOnlySql('UPDATE t SET a = 1')).toBe(false)
    expect(isReadOnlySql('INSERT INTO t VALUES (1)')).toBe(false)
    expect(isReadOnlySql('DROP TABLE t')).toBe(false)
    expect(isReadOnlySql('ATTACH DATABASE "x" AS y')).toBe(false)
  })
  it('is not fooled by a leading comment', () => {
    expect(isReadOnlySql('-- select all\nDELETE FROM t')).toBe(false)
    expect(isReadOnlySql('/* note */ SELECT 1')).toBe(true)
  })
  it('rejects a batch that hides a write among reads', () => {
    expect(isReadOnlySql('SELECT 1; DELETE FROM t')).toBe(false)
  })
  it('rejects empty input', () => {
    expect(isReadOnlySql('   ')).toBe(false)
    expect(isReadOnlySql('-- just a comment')).toBe(false)
  })
})

// --- integration over a real on-disk SQLite file -------------------------------

let dir: string
let dbPath: string

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-sqlite-db-'))
  dbPath = path.join(dir, 'test.db')

  const SQL = await initSqlJs()
  const db = new SQL.Database()
  db.run(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER);
    INSERT INTO users (name, age) VALUES ('Ada', 36), ('Alan', 41), ('Grace', 52);
    CREATE VIEW adults AS SELECT name FROM users WHERE age >= 18;
  `)
  fs.writeFileSync(dbPath, Buffer.from(db.export()))
  db.close()
})

afterEach(() => {
  clearCache()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('listTables', () => {
  it('lists user tables and views, tables first, no sqlite_* internals', async () => {
    const tables = await listTables(dbPath)
    expect(tables).toEqual([
      { name: 'users', type: 'table' },
      { name: 'adults', type: 'view' },
    ])
  })
})

describe('readTable', () => {
  it('returns columns, rows, and total', async () => {
    const page = await readTable(dbPath, 'users')
    expect(page.total).toBe(3)
    expect(page.columns.map((c) => c.name)).toEqual(['id', 'name', 'age'])
    expect(page.columns.find((c) => c.name === 'id')?.pk).toBe(true)
    expect(page.rows.length).toBe(3)
  })

  it('paginates and orders by a valid column', async () => {
    const page = await readTable(dbPath, 'users', { limit: 1, offset: 1, orderBy: 'age', dir: 'desc' })
    expect(page.rows.length).toBe(1)
    expect(page.orderBy).toBe('age')
    expect(page.dir).toBe('desc')
    // age desc = [52, 41, 36]; offset 1 => 41 (Alan)
    expect(page.rows[0]).toContain('Alan')
  })

  it('ignores an unknown orderBy column instead of injecting it', async () => {
    const page = await readTable(dbPath, 'users', { orderBy: 'age; DROP TABLE users' })
    expect(page.orderBy).toBeNull()
    expect(page.total).toBe(3)
  })

  it('throws on an unknown table', async () => {
    await expect(readTable(dbPath, 'nope')).rejects.toThrow(/Unknown table/)
  })
})

describe('runQuery', () => {
  it('runs a read-only query', async () => {
    const res = await runQuery(dbPath, 'SELECT name FROM users ORDER BY age')
    expect(res.columns).toEqual(['name'])
    expect(res.rows.map((r) => r[0])).toEqual(['Ada', 'Alan', 'Grace'])
  })

  it('rejects a write statement', async () => {
    await expect(runQuery(dbPath, 'DELETE FROM users')).rejects.toThrow(/read-only/)
  })
})

describe('cache reloads on file change', () => {
  it('picks up new rows after the file is rewritten', async () => {
    expect((await readTable(dbPath, 'users')).total).toBe(3)

    const SQL = await initSqlJs()
    const db = new SQL.Database(fs.readFileSync(dbPath))
    db.run("INSERT INTO users (name, age) VALUES ('Edsger', 45)")
    // Bump mtime explicitly so the change is observable even on coarse clocks.
    fs.writeFileSync(dbPath, Buffer.from(db.export()))
    const future = new Date(Date.now() + 2000)
    fs.utimesSync(dbPath, future, future)
    db.close()

    expect((await readTable(dbPath, 'users')).total).toBe(4)
  })
})
