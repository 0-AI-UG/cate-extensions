// =============================================================================
// On-disk store for <workspace>/.cate/mcp.json. Write contract:
// stat-before-read snapshots, atomic temp+rename writes, and a 409
// when the file changed on disk between snapshot and write (an external writer
// wins; the caller re-reads). Also hosts the debounced external-edit watcher.
// =============================================================================

import fs from 'fs'
import path from 'path'
import { CONFIG_RELATIVE_PATH, parseConfigText, serializeConfigDoc, type JsonObject, type ParsedConfigDoc } from '../shared/config'

export interface ConfigSnapshot {
  file: string
  /** true when mcp.json exists on disk. */
  exists: boolean
  /** '' when the file doesn't exist yet. */
  text: string
  /** null when the file doesn't exist yet. */
  mtime: number | null
  parsed: ParsedConfigDoc | null
  /** Whole-file parse error; parsed is null when set. */
  error: string | null
}

export interface WriteResult {
  ok: boolean
  status?: number
  error?: string
}

export class ConfigStore {
  readonly file: string
  private watcher: fs.FSWatcher | null = null
  private watchRetry: NodeJS.Timeout | null = null
  private debounce: NodeJS.Timeout | null = null
  /** Serialized text of our own last write, so the watcher can skip self-echo. */
  private lastWrittenText: string | null = null

  constructor(workspaceRoot: string) {
    this.file = path.join(workspaceRoot, CONFIG_RELATIVE_PATH)
  }

  read(): ConfigSnapshot {
    let mtime: number | null = null
    try {
      mtime = fs.statSync(this.file).mtimeMs
    } catch {
      return { file: this.file, exists: false, text: '', mtime: null, parsed: parseEmpty(), error: null }
    }
    let text: string
    try {
      text = fs.readFileSync(this.file, 'utf8')
    } catch (err) {
      // Exists but unreadable: surface, never treat as empty (a write would clobber).
      return {
        file: this.file,
        exists: true,
        text: '',
        mtime,
        parsed: null,
        error: err instanceof Error ? err.message : String(err),
      }
    }
    const parsed = parseConfigText(text)
    if (!parsed.ok) {
      return { file: this.file, exists: true, text, mtime, parsed: null, error: parsed.error }
    }
    return { file: this.file, exists: true, text, mtime, parsed: parsed.parsed, error: null }
  }

  /** Atomically write the (mutated) document. Refuses with 409 when the file
   *  changed on disk after `snap` was taken. */
  writeDoc(snap: ConfigSnapshot, doc: JsonObject): WriteResult {
    let mtimeNow: number | null = null
    try {
      mtimeNow = fs.statSync(this.file).mtimeMs
    } catch {
      mtimeNow = null
    }
    if (mtimeNow !== snap.mtime) {
      return { ok: false, status: 409, error: 'mcp.json changed on disk while saving; reloaded, try again' }
    }
    const text = serializeConfigDoc(doc)
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.cate-${process.pid}.tmp`
      fs.writeFileSync(tmp, text, 'utf8')
      fs.renameSync(tmp, this.file)
      this.lastWrittenText = text
      return { ok: true }
    } catch (err) {
      return { ok: false, status: 500, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** Watch .cate/ for external edits of mcp.json. The .cate dir may not exist
   *  yet; retry establishing the watch until it does, and re-check the file on
   *  every (re)attach so an edit made while unwatched is not missed. Self-
   *  writes are skipped by comparing against the text we last wrote. */
  watch(onExternalChange: () => void): void {
    const dir = path.dirname(this.file)
    // Baseline: whatever is on disk right now was already applied by the
    // caller's initial read; only later differences count as external edits.
    try {
      this.lastWrittenText = fs.readFileSync(this.file, 'utf8')
    } catch {
      this.lastWrittenText = null
    }
    const checkNow = (): void => {
      let text: string | null = null
      try {
        text = fs.readFileSync(this.file, 'utf8')
      } catch {
        text = null // deleted counts as an external change
      }
      if (text === this.lastWrittenText) return
      this.lastWrittenText = text
      onExternalChange()
    }
    const scheduleCheck = (): void => {
      if (this.debounce) clearTimeout(this.debounce)
      this.debounce = setTimeout(() => {
        this.debounce = null
        checkNow()
      }, 300)
    }
    const attach = (): void => {
      try {
        this.watcher = fs.watch(dir, (_event, filename) => {
          if (filename && filename !== path.basename(this.file)) return
          scheduleCheck()
        })
        this.watcher.on('error', () => {
          this.watcher?.close()
          this.watcher = null
          retryLater()
        })
        // Anything written while we weren't watching (or before the .cate dir
        // existed) must surface now, not on the next unrelated edit.
        checkNow()
      } catch {
        retryLater()
      }
    }
    const retryLater = (): void => {
      if (this.watchRetry) return
      this.watchRetry = setTimeout(() => {
        this.watchRetry = null
        attach()
      }, 1000)
      this.watchRetry.unref()
    }
    attach()
  }

  close(): void {
    this.watcher?.close()
    this.watcher = null
    if (this.watchRetry) clearTimeout(this.watchRetry)
    if (this.debounce) clearTimeout(this.debounce)
  }
}

function parseEmpty(): ParsedConfigDoc {
  const parsed = parseConfigText('')
  if (!parsed.ok) throw new Error('unreachable: empty config must parse')
  return parsed.parsed
}
