import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { AgentInstaller, ENTRY_NAME } from './agent-install'

let tmp: string
const EP = { url: 'http://127.0.0.1:40000/mcp', token: 'tok-abc' }
const EP2 = { url: 'http://127.0.0.1:59999/mcp', token: 'tok-xyz' }

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-mcp-agent-'))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function read(rel: string): string {
  return fs.readFileSync(path.join(tmp, rel), 'utf8')
}
function write(rel: string, text: string): void {
  const file = path.join(tmp, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}
function statusOf(inst: AgentInstaller, id: string) {
  return inst.list(EP).find((a) => a.id === id)!
}

describe('AgentInstaller.list', () => {
  it('lists all agents; two are unsupported with a reason', () => {
    const agents = new AgentInstaller(tmp).list(EP)
    expect(agents.map((a) => a.id).sort()).toEqual(
      ['agent-panel', 'antigravity', 'claude-code', 'codex', 'cursor', 'opencode', 'pi'].sort(),
    )
    const anti = agents.find((a) => a.id === 'antigravity')!
    const pi = agents.find((a) => a.id === 'pi')!
    expect(anti.supported).toBe(false)
    expect(anti.reason).toBeTruthy()
    expect(pi.supported).toBe(false)
    expect(agents.filter((a) => a.supported).map((a) => a.id).sort()).toEqual(
      ['agent-panel', 'claude-code', 'codex', 'cursor', 'opencode'],
    )
  })

  it('nothing installed on a clean workspace', () => {
    for (const a of new AgentInstaller(tmp).list(EP)) expect(a.installed).toBe(false)
  })
})

describe('Claude Code (.mcp.json)', () => {
  it('installs an http server, preserving unknown keys', () => {
    write('.mcp.json', JSON.stringify({ mcpServers: { other: { command: 'x' } }, custom: 1 }, null, 2))
    const inst = new AgentInstaller(tmp)
    expect(inst.install('claude-code', EP)).toEqual({ ok: true })
    const doc = JSON.parse(read('.mcp.json'))
    expect(doc.custom).toBe(1)
    expect(doc.mcpServers.other).toEqual({ command: 'x' })
    expect(doc.mcpServers[ENTRY_NAME]).toEqual({
      type: 'http',
      url: EP.url,
      headers: { Authorization: `Bearer ${EP.token}` },
    })
    expect(statusOf(inst, 'claude-code').installed).toBe(true)
  })

  it('creates the file when absent', () => {
    const inst = new AgentInstaller(tmp)
    expect(inst.install('claude-code', EP)).toEqual({ ok: true })
    expect(JSON.parse(read('.mcp.json')).mcpServers[ENTRY_NAME].url).toBe(EP.url)
  })

  it('flags a stale install when the endpoint url changed', () => {
    const inst = new AgentInstaller(tmp)
    inst.install('claude-code', EP)
    const stale = inst.list(EP2).find((a) => a.id === 'claude-code')!
    expect(stale.installed).toBe(true)
    expect(stale.stale).toBe(true)
    // Re-install against the new endpoint clears staleness.
    inst.install('claude-code', EP2)
    expect(inst.list(EP2).find((a) => a.id === 'claude-code')!.stale).toBe(false)
  })

  it('uninstall removes only our entry', () => {
    write('.mcp.json', JSON.stringify({ mcpServers: { other: { command: 'x' } } }))
    const inst = new AgentInstaller(tmp)
    inst.install('claude-code', EP)
    expect(inst.uninstall('claude-code')).toEqual({ ok: true })
    const doc = JSON.parse(read('.mcp.json'))
    expect(doc.mcpServers[ENTRY_NAME]).toBeUndefined()
    expect(doc.mcpServers.other).toEqual({ command: 'x' })
  })

  it('refuses to clobber invalid JSON', () => {
    write('.mcp.json', '{ not json')
    const res = new AgentInstaller(tmp).install('claude-code', EP)
    expect(res.ok).toBe(false)
    expect(read('.mcp.json')).toBe('{ not json')
  })
})

describe('Agent panel (.pi/mcp.json, read by pi-mcp-adapter)', () => {
  it('installs a url entry the adapter can read', () => {
    const inst = new AgentInstaller(tmp)
    expect(inst.install('agent-panel', EP)).toEqual({ ok: true })
    const entry = JSON.parse(read('.pi/mcp.json')).mcpServers[ENTRY_NAME]
    expect(entry).toEqual({ url: EP.url, headers: { Authorization: `Bearer ${EP.token}` } })
    expect(statusOf(inst, 'agent-panel').installed).toBe(true)
  })
})

describe('Cursor (.cursor/mcp.json)', () => {
  it('installs a url entry without a type key', () => {
    const inst = new AgentInstaller(tmp)
    expect(inst.install('cursor', EP)).toEqual({ ok: true })
    const entry = JSON.parse(read('.cursor/mcp.json')).mcpServers[ENTRY_NAME]
    expect(entry).toEqual({ url: EP.url, headers: { Authorization: `Bearer ${EP.token}` } })
    expect(entry.type).toBeUndefined()
  })
})

describe('OpenCode (opencode.json)', () => {
  it('installs under the mcp block with a fresh $schema', () => {
    const inst = new AgentInstaller(tmp)
    expect(inst.install('opencode', EP)).toEqual({ ok: true })
    const doc = JSON.parse(read('opencode.json'))
    expect(doc.$schema).toBe('https://opencode.ai/config.json')
    expect(doc.mcp[ENTRY_NAME]).toEqual({
      type: 'remote',
      url: EP.url,
      enabled: true,
      headers: { Authorization: `Bearer ${EP.token}` },
    })
  })

  it('does not overwrite an existing $schema', () => {
    write('opencode.json', JSON.stringify({ $schema: 'custom', model: 'x' }))
    const inst = new AgentInstaller(tmp)
    inst.install('opencode', EP)
    const doc = JSON.parse(read('opencode.json'))
    expect(doc.$schema).toBe('custom')
    expect(doc.model).toBe('x')
  })
})

describe('Codex (.codex/config.toml)', () => {
  it('appends a block, preserving existing content', () => {
    write('.codex/config.toml', 'model = "gpt-5"\n\n[mcp_servers.other]\nurl = "http://x"\n')
    const inst = new AgentInstaller(tmp)
    expect(inst.install('codex', EP)).toEqual({ ok: true })
    const text = read('.codex/config.toml')
    expect(text).toContain('model = "gpt-5"')
    expect(text).toContain('[mcp_servers.other]')
    expect(text).toContain(`[mcp_servers.${ENTRY_NAME}]`)
    expect(text).toContain(`url = "${EP.url}"`)
    expect(text).toContain(`http_headers = { "Authorization" = "Bearer ${EP.token}" }`)
    expect(statusOf(inst, 'codex').installed).toBe(true)
  })

  it('replaces our block in place on re-install (no duplicate)', () => {
    const inst = new AgentInstaller(tmp)
    inst.install('codex', EP)
    inst.install('codex', EP2)
    const text = read('.codex/config.toml')
    expect(text.match(/\[mcp_servers\.cate\]/g)!.length).toBe(1)
    expect(text).toContain(EP2.url)
    expect(text).not.toContain(EP.url)
  })

  it('detects staleness from the url line', () => {
    const inst = new AgentInstaller(tmp)
    inst.install('codex', EP)
    expect(inst.list(EP2).find((a) => a.id === 'codex')!.stale).toBe(true)
  })

  it('uninstall drops our block but keeps the rest', () => {
    write('.codex/config.toml', 'model = "gpt-5"\n')
    const inst = new AgentInstaller(tmp)
    inst.install('codex', EP)
    expect(inst.uninstall('codex')).toEqual({ ok: true })
    const text = read('.codex/config.toml')
    expect(text).toContain('model = "gpt-5"')
    expect(text).not.toContain('[mcp_servers.cate]')
  })
})

describe('unsupported agents', () => {
  it('install/uninstall reject with the reason and write nothing', () => {
    const inst = new AgentInstaller(tmp)
    const res = inst.install('antigravity', EP)
    expect(res.ok).toBe(false)
    const pi = inst.install('pi', EP)
    expect(pi.ok).toBe(false)
    expect(fs.readdirSync(tmp)).toHaveLength(0)
  })

  it('unknown agent id is an error', () => {
    expect(new AgentInstaller(tmp).install('nope', EP).ok).toBe(false)
  })
})
