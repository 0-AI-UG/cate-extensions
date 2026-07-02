import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  findSqliteFiles,
  isSqliteHeader,
  hasSqliteExtension,
  shouldSkipDir,
  SQLITE_MAGIC,
} from './scan'

let root: string

function writeSqlite(rel: string): string {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, Buffer.concat([SQLITE_MAGIC, Buffer.alloc(64)]))
  return abs
}

function writePlain(rel: string, content = 'not a database'): string {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
  return abs
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-datasette-scan-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('isSqliteHeader', () => {
  it('matches the 16-byte magic', () => {
    expect(isSqliteHeader(Buffer.concat([SQLITE_MAGIC, Buffer.from('rest')]))).toBe(true)
    expect(isSqliteHeader(Buffer.from('SQLite format 3x'))).toBe(false)
    expect(isSqliteHeader(Buffer.alloc(4))).toBe(false)
  })
})

describe('hasSqliteExtension / shouldSkipDir', () => {
  it('accepts .db/.sqlite/.sqlite3 case-insensitively', () => {
    expect(hasSqliteExtension('a.db')).toBe(true)
    expect(hasSqliteExtension('a.SQLITE')).toBe(true)
    expect(hasSqliteExtension('a.sqlite3')).toBe(true)
    expect(hasSqliteExtension('a.dbf')).toBe(false)
    expect(hasSqliteExtension('db')).toBe(false)
  })

  it('skips hidden and dependency/build dirs', () => {
    expect(shouldSkipDir('.git')).toBe(true)
    expect(shouldSkipDir('.cate')).toBe(true)
    expect(shouldSkipDir('node_modules')).toBe(true)
    expect(shouldSkipDir('dist')).toBe(true)
    expect(shouldSkipDir('src')).toBe(false)
  })
})

describe('findSqliteFiles', () => {
  it('finds magic-verified SQLite files and ignores impostors', () => {
    const good = writeSqlite('data/app.db')
    writePlain('data/fake.db') // right extension, wrong bytes
    writeSqlite('notes.sqlite')
    writePlain('readme.md')

    const found = findSqliteFiles(root)
    expect(found).toContain(good)
    expect(found).toHaveLength(2)
    expect(found.every((f) => !f.endsWith('fake.db'))).toBe(true)
  })

  it('does not descend into skipped or hidden directories', () => {
    writeSqlite('node_modules/dep/cache.db')
    writeSqlite('.cate/state.db')
    const good = writeSqlite('src/store/local.sqlite3')

    expect(findSqliteFiles(root)).toEqual([good])
  })

  it('respects the depth bound', () => {
    writeSqlite('a/b/c/deep.db')
    expect(findSqliteFiles(root, { maxDepth: 2 })).toEqual([])
    expect(findSqliteFiles(root, { maxDepth: 3 })).toHaveLength(1)
  })

  it('caps and sorts the result set', () => {
    for (let i = 0; i < 6; i++) writeSqlite(`db-${i}.db`)
    const found = findSqliteFiles(root, { maxFiles: 4 })
    expect(found).toHaveLength(4)
    expect(found).toEqual([...found].sort())
  })

  it('returns empty for an unreadable root', () => {
    expect(findSqliteFiles(path.join(root, 'missing'))).toEqual([])
  })
})
