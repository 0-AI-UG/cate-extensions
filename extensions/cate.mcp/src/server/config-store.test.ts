import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { ConfigStore } from './config-store'

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-mcp-store-'))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function writeConfig(text: string): string {
  const file = path.join(tmp, '.cate', 'mcp.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  return file
}

describe('ConfigStore.read', () => {
  it('missing file reads as not-initialized with an empty parsed doc', () => {
    const store = new ConfigStore(tmp)
    const snap = store.read()
    expect(snap.exists).toBe(false)
    expect(snap.error).toBeNull()
    expect(snap.parsed?.servers.size).toBe(0)
  })

  it('corrupt JSON surfaces the error instead of rendering empty', () => {
    writeConfig('{ definitely not json')
    const snap = new ConfigStore(tmp).read()
    expect(snap.exists).toBe(true)
    expect(snap.parsed).toBeNull()
    expect(snap.error).toContain('not valid JSON')
  })

  it('valid config parses', () => {
    writeConfig('{"mcpServers": {"a": {"command": "x"}}}')
    const snap = new ConfigStore(tmp).read()
    expect(snap.parsed?.servers.get('a')?.config?.kind).toBe('stdio')
  })
})

describe('ConfigStore.writeDoc', () => {
  it('writes atomically, creating .cate on demand', () => {
    const store = new ConfigStore(tmp)
    const snap = store.read()
    const result = store.writeDoc(snap, { mcpServers: { a: { command: 'x' } } })
    expect(result.ok).toBe(true)
    const text = fs.readFileSync(store.file, 'utf8')
    expect(JSON.parse(text).mcpServers.a.command).toBe('x')
    expect(text.endsWith('\n')).toBe(true)
  })

  it('refuses with 409 when the file changed after the snapshot', () => {
    const file = writeConfig('{"mcpServers": {}}')
    const store = new ConfigStore(tmp)
    const snap = store.read()
    // Simulate a concurrent external writer with a guaranteed-different mtime.
    fs.writeFileSync(file, '{"mcpServers": {"sneaky": {"command": "y"}}}')
    const future = new Date(Date.now() + 5000)
    fs.utimesSync(file, future, future)
    const result = store.writeDoc(snap, { mcpServers: {} })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(409)
    // The external content must survive.
    expect(fs.readFileSync(file, 'utf8')).toContain('sneaky')
  })

  it('409s when the file was created after an empty snapshot', () => {
    const store = new ConfigStore(tmp)
    const snap = store.read() // no file yet
    writeConfig('{"mcpServers": {"raced": {"command": "z"}}}')
    const result = store.writeDoc(snap, { mcpServers: {} })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(409)
  })
})

describe('ConfigStore.watch', () => {
  it('fires on external edits and skips its own writes', async () => {
    writeConfig('{"mcpServers": {}}')
    const store = new ConfigStore(tmp)
    let fired = 0
    store.watch(() => fired++)
    try {
      // Own write: must NOT fire.
      const snap = store.read()
      expect(store.writeDoc(snap, { mcpServers: {} }).ok).toBe(true)
      await new Promise((r) => setTimeout(r, 500))
      expect(fired).toBe(0)
      // External write: must fire (debounced).
      fs.writeFileSync(store.file, '{"mcpServers": {"ext": {"command": "x"}}}')
      await new Promise((r) => setTimeout(r, 700))
      expect(fired).toBeGreaterThanOrEqual(1)
    } finally {
      store.close()
    }
  })
})
