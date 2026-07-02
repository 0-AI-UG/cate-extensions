import { describe, expect, it } from 'vitest'
import {
  diffConfigs,
  expandConfig,
  normalizeServerEntry,
  parseConfigText,
  removeServerFromDoc,
  serializeConfigDoc,
  setDisabledInDoc,
  upsertServerInDoc,
  validateConfigInput,
  validateServerName,
} from './config'
import type { ServerConfig } from './types'

function parsed(text: string) {
  const result = parseConfigText(text)
  if (!result.ok) throw new Error(result.error)
  return result.parsed
}

describe('validateServerName', () => {
  it('accepts tame names', () => {
    expect(validateServerName('filesystem').ok).toBe(true)
    expect(validateServerName('my-server.v2_beta').ok).toBe(true)
  })

  it('rejects the namespacing separator', () => {
    const r = validateServerName('foo__bar')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('__')
  })

  it('rejects empty, non-string, weird charset, over-long', () => {
    expect(validateServerName('').ok).toBe(false)
    expect(validateServerName(42).ok).toBe(false)
    expect(validateServerName('has space').ok).toBe(false)
    expect(validateServerName('sl/ash').ok).toBe(false)
    expect(validateServerName('-leading').ok).toBe(false)
    expect(validateServerName('x'.repeat(65)).ok).toBe(false)
  })
})

describe('normalizeServerEntry', () => {
  it('normalizes a stdio entry with defaults', () => {
    const r = normalizeServerEntry({ command: 'npx', args: ['-y', 'pkg'], env: { A: '1' }, cwd: '/tmp' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.config).toEqual({ kind: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { A: '1' }, cwd: '/tmp', disabled: false })
    }
  })

  it('normalizes a remote entry and disabled flag', () => {
    const r = normalizeServerEntry({ url: 'https://x.test/mcp', headers: { Authorization: 'Bearer t' }, disabled: true })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.config).toEqual({ kind: 'remote', url: 'https://x.test/mcp', headers: { Authorization: 'Bearer t' }, disabled: true })
  })

  it('rejects both command and url, neither, and bad field types', () => {
    expect(normalizeServerEntry({ command: 'x', url: 'y' }).ok).toBe(false)
    expect(normalizeServerEntry({}).ok).toBe(false)
    expect(normalizeServerEntry({ command: 'x', args: [1] }).ok).toBe(false)
    expect(normalizeServerEntry({ command: 'x', env: { A: 2 } }).ok).toBe(false)
    expect(normalizeServerEntry({ url: '' }).ok).toBe(false)
    expect(normalizeServerEntry('nope').ok).toBe(false)
  })
})

describe('parseConfigText', () => {
  it('parses empty text as an empty config', () => {
    const p = parsed('')
    expect(p.servers.size).toBe(0)
  })

  it('surfaces invalid JSON and wrong shapes', () => {
    expect(parseConfigText('{ nope').ok).toBe(false)
    expect(parseConfigText('[1]').ok).toBe(false)
    expect(parseConfigText('{"mcpServers": []}').ok).toBe(false)
  })

  it('keeps invalid entries visible with their error', () => {
    const p = parsed('{"mcpServers": {"good": {"command": "x"}, "bad": {"nope": 1}, "worse__name": {"command": "x"}}}')
    expect(p.servers.get('good')?.config?.kind).toBe('stdio')
    expect(p.servers.get('bad')?.config).toBeNull()
    expect(p.servers.get('bad')?.error).toBeTruthy()
    expect(p.servers.get('worse__name')?.config).toBeNull()
    expect(p.servers.get('worse__name')?.error).toContain('__')
  })
})

describe('document mutations preserve unknown keys', () => {
  const original =
    '{"$comment": "keep me", "mcpServers": {"a": {"command": "x", "customField": {"deep": true}}}, "extraTop": [1, 2]}'

  it('upsert keeps unknown top-level and per-server keys', () => {
    const p = parsed(original)
    upsertServerInDoc(p.doc, 'a', { command: 'y', args: ['1'], env: {} })
    const text = serializeConfigDoc(p.doc)
    const round = JSON.parse(text)
    expect(round.$comment).toBe('keep me')
    expect(round.extraTop).toEqual([1, 2])
    expect(round.mcpServers.a.customField).toEqual({ deep: true })
    expect(round.mcpServers.a.command).toBe('y')
    expect(round.mcpServers.a.args).toEqual(['1'])
  })

  it('switching transport kind drops the other kind\'s managed keys only', () => {
    const p = parsed(original)
    upsertServerInDoc(p.doc, 'a', { url: 'https://x.test', headers: { H: '1' } })
    const round = JSON.parse(serializeConfigDoc(p.doc))
    expect(round.mcpServers.a.command).toBeUndefined()
    expect(round.mcpServers.a.url).toBe('https://x.test')
    expect(round.mcpServers.a.customField).toEqual({ deep: true })
  })

  it('remove and disable behave and report unknown names', () => {
    const p = parsed(original)
    expect(setDisabledInDoc(p.doc, 'a', true)).toBe(true)
    expect((p.doc.mcpServers as Record<string, { disabled?: boolean }>).a.disabled).toBe(true)
    expect(setDisabledInDoc(p.doc, 'a', false)).toBe(true)
    expect((p.doc.mcpServers as Record<string, { disabled?: boolean }>).a.disabled).toBeUndefined()
    expect(setDisabledInDoc(p.doc, 'missing', true)).toBe(false)
    expect(removeServerFromDoc(p.doc, 'missing')).toBe(false)
    expect(removeServerFromDoc(p.doc, 'a')).toBe(true)
    expect(JSON.parse(serializeConfigDoc(p.doc)).mcpServers.a).toBeUndefined()
  })
})

describe('validateConfigInput', () => {
  it('requires exactly one of command/url', () => {
    expect(validateConfigInput({}).ok).toBe(false)
    expect(validateConfigInput({ command: 'x', url: 'y' }).ok).toBe(false)
    expect(validateConfigInput({ command: 'x' }).ok).toBe(true)
    expect(validateConfigInput({ url: 'https://x.test' }).ok).toBe(true)
    expect(validateConfigInput(null).ok).toBe(false)
  })
})

describe('diffConfigs', () => {
  it('classifies added/removed/changed and ignores untouched', () => {
    const before = parsed('{"mcpServers": {"a": {"command": "x"}, "b": {"command": "y"}, "c": {"command": "z"}}}')
    const after = parsed('{"mcpServers": {"a": {"command": "x"}, "b": {"command": "y2"}, "d": {"url": "https://x.test"}}}')
    const diff = diffConfigs(before, after)
    expect(diff.added).toEqual(['d'])
    expect(diff.removed).toEqual(['c'])
    expect(diff.changed).toEqual(['b'])
  })

  it('a disabled toggle counts as changed; null prev means all added', () => {
    const before = parsed('{"mcpServers": {"a": {"command": "x"}}}')
    const after = parsed('{"mcpServers": {"a": {"command": "x", "disabled": true}}}')
    expect(diffConfigs(before, after).changed).toEqual(['a'])
    expect(diffConfigs(null, after).added).toEqual(['a'])
  })
})

describe('expandConfig (${env:VAR})', () => {
  const stdio: ServerConfig = {
    kind: 'stdio',
    command: '${env:RUNNER}',
    args: ['--token', '${env:TOKEN}', 'plain'],
    env: { KEY: 'pre-${env:TOKEN}-post' },
    cwd: '${env:HOME_DIR}/sub',
    disabled: false,
  }

  it('expands command, args, env values and cwd', () => {
    const r = expandConfig(stdio, { RUNNER: 'npx', TOKEN: 'sekret', HOME_DIR: '/home/u' })
    expect(r.ok).toBe(true)
    if (r.ok && r.config.kind === 'stdio') {
      expect(r.config.command).toBe('npx')
      expect(r.config.args).toEqual(['--token', 'sekret', 'plain'])
      expect(r.config.env.KEY).toBe('pre-sekret-post')
      expect(r.config.cwd).toBe('/home/u/sub')
    }
  })

  it('never mutates the stored config (placeholders stay in the file form)', () => {
    const r = expandConfig(stdio, { RUNNER: 'npx', TOKEN: 't', HOME_DIR: '/h' })
    expect(r.ok).toBe(true)
    expect(stdio.command).toBe('${env:RUNNER}')
    expect(stdio.env.KEY).toBe('pre-${env:TOKEN}-post')
  })

  it('expands url and headers for remote configs', () => {
    const remote: ServerConfig = {
      kind: 'remote',
      url: 'https://${env:REGION}.example.com/mcp',
      headers: { Authorization: 'Bearer ${env:TOKEN}' },
      disabled: false,
    }
    const r = expandConfig(remote, { REGION: 'eu', TOKEN: 'abc' })
    expect(r.ok).toBe(true)
    if (r.ok && r.config.kind === 'remote') {
      expect(r.config.url).toBe('https://eu.example.com/mcp')
      expect(r.config.headers.Authorization).toBe('Bearer abc')
    }
  })

  it('reports every missing variable instead of silently launching', () => {
    const r = expandConfig(stdio, {})
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('HOME_DIR')
      expect(r.error).toContain('RUNNER')
      expect(r.error).toContain('TOKEN')
    }
  })
})
