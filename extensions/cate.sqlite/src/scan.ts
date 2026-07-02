// =============================================================================
// Workspace SQLite discovery: find the .db / .sqlite / .sqlite3 files under the
// workspace root worth showing in the viewer.
//
// Extension-of-file alone is not enough (".db" is used by plenty of non-SQLite
// formats), so every candidate is gated on the 16-byte SQLite magic header
// ("SQLite format 3\0"). The walk is bounded (depth + file count) and skips the
// usual dependency/build/VCS directories so a big workspace doesn't stall the
// panel's first open.
// =============================================================================

import fs from 'fs'
import path from 'path'

/** File extensions considered SQLite candidates (magic-checked before use). */
const SQLITE_EXTENSIONS = new Set(['.db', '.sqlite', '.sqlite3'])

/** Directories never descended into (dependencies, build output, VCS, caches). */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  '__pycache__',
  'venv',
  '.venv',
])

/** The 16-byte magic header every SQLite 3 database file starts with. */
export const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1')

export interface ScanOptions {
  /** Max directory depth below the root. Default 5. */
  maxDepth?: number
  /** Cap on databases returned. Default 20. */
  maxFiles?: number
}

/** True when a directory entry name should not be descended into: hidden dirs
 *  (.git, .cate, …) and the SKIP_DIRS set. Exported for tests. */
export function shouldSkipDir(name: string): boolean {
  return name.startsWith('.') || SKIP_DIRS.has(name)
}

/** True when a file name has a SQLite-candidate extension. Exported for tests. */
export function hasSqliteExtension(name: string): boolean {
  return SQLITE_EXTENSIONS.has(path.extname(name).toLowerCase())
}

/** True when `buf` starts with the SQLite 3 magic header. Exported for tests. */
export function isSqliteHeader(buf: Buffer): boolean {
  return buf.length >= SQLITE_MAGIC.length && buf.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)
}

/** Read just the first 16 bytes of a file (false on any error — unreadable
 *  candidates are silently skipped, not fatal to the scan). */
function fileHasSqliteMagic(file: string): boolean {
  let fd: number | null = null
  try {
    fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(SQLITE_MAGIC.length)
    const read = fs.readSync(fd, buf, 0, buf.length, 0)
    return read === buf.length && isSqliteHeader(buf)
  } catch {
    return false
  } finally {
    if (fd != null) fs.closeSync(fd)
  }
}

/**
 * Find SQLite databases under `root`: breadth-first, bounded walk over
 * non-hidden directories, returning absolute paths of files that carry a
 * SQLite-candidate extension AND the SQLite magic header. Results are sorted
 * (stable across runs) and capped at `maxFiles`.
 */
export function findSqliteFiles(root: string, opts: ScanOptions = {}): string[] {
  const maxDepth = opts.maxDepth ?? 5
  const maxFiles = opts.maxFiles ?? 20
  const found: string[] = []

  let level: string[] = [root]
  for (let depth = 0; depth <= maxDepth && level.length > 0; depth++) {
    const next: string[] = []
    for (const dir of level) {
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        continue // unreadable dir — skip, not fatal
      }
      for (const entry of entries) {
        const abs = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (!shouldSkipDir(entry.name)) next.push(abs)
        } else if (entry.isFile() && hasSqliteExtension(entry.name)) {
          if (fileHasSqliteMagic(abs)) found.push(abs)
        }
      }
    }
    level = next
  }

  found.sort()
  return found.slice(0, maxFiles)
}
