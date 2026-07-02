import { describe, it, expect } from 'vitest'
import {
  parseDatasetteCmd,
  resolveLaunch,
  normalizePublicBase,
  baseUrlFor,
  childArgs,
  childEnv,
  DATASETTE_SUBPATH,
} from './datasette'

describe('parseDatasetteCmd', () => {
  it('returns null for unset/empty', () => {
    expect(parseDatasetteCmd(undefined)).toBeNull()
    expect(parseDatasetteCmd('')).toBeNull()
    expect(parseDatasetteCmd('   ')).toBeNull()
  })

  it('splits command + args on whitespace', () => {
    expect(parseDatasetteCmd('python3 -m datasette')).toEqual({
      command: 'python3',
      args: ['-m', 'datasette'],
      via: 'env',
    })
  })

  it('handles a bare command', () => {
    expect(parseDatasetteCmd('/opt/venv/bin/datasette')).toEqual({
      command: '/opt/venv/bin/datasette',
      args: [],
      via: 'env',
    })
  })
})

describe('resolveLaunch', () => {
  it('prefers the DATASETTE_CMD override over everything', () => {
    const spec = resolveLaunch({ DATASETTE_CMD: 'python3 -m datasette' }, () => true)
    expect(spec).toEqual({ command: 'python3', args: ['-m', 'datasette'], via: 'env' })
  })

  it('uses datasette on PATH before uvx/pipx', () => {
    const spec = resolveLaunch({}, (cmd) => cmd === 'datasette' || cmd === 'uvx')
    expect(spec).toEqual({ command: 'datasette', args: [], via: 'bin' })
  })

  it('falls back to uvx, then pipx', () => {
    expect(resolveLaunch({}, (cmd) => cmd === 'uvx' || cmd === 'pipx')).toEqual({
      command: 'uvx',
      args: ['datasette'],
      via: 'uvx',
    })
    expect(resolveLaunch({}, (cmd) => cmd === 'pipx')).toEqual({
      command: 'pipx',
      args: ['run', 'datasette'],
      via: 'pipx',
    })
  })

  it('returns null when nothing resolves', () => {
    expect(resolveLaunch({}, () => false)).toBeNull()
  })
})

describe('normalizePublicBase', () => {
  it('accepts the proxied panel prefix shape', () => {
    expect(normalizePublicBase('/ext/a1b2c3d4/')).toBe('/ext/a1b2c3d4/')
    expect(normalizePublicBase('/')).toBe('/')
  })

  it('rejects non-strings and malformed paths', () => {
    expect(normalizePublicBase(undefined)).toBeNull()
    expect(normalizePublicBase(42)).toBeNull()
    expect(normalizePublicBase('ext/x/')).toBeNull() // not absolute
    expect(normalizePublicBase('/ext/x')).toBeNull() // no trailing slash
    expect(normalizePublicBase('/ext/../x/')).toBeNull() // traversal
    expect(normalizePublicBase('/ext/a b/')).toBeNull() // space
    expect(normalizePublicBase('/ext/x/?q=1')).toBeNull() // query chars
    expect(normalizePublicBase('//evil.example/')).toBeNull() // protocol-relative
    expect(normalizePublicBase('/' + 'a/'.repeat(200))).toBeNull() // too long
  })
})

describe('childArgs', () => {
  it('passes db files, loopback binding and the composed base_url', () => {
    expect(childArgs(['/w/a.db', '/w/b.sqlite'], 4321, '/ext/tok/')).toEqual([
      '/w/a.db',
      '/w/b.sqlite',
      '--host',
      '127.0.0.1',
      '--port',
      '4321',
      '--setting',
      'base_url',
      '/ext/tok/' + DATASETTE_SUBPATH,
    ])
  })

  it('substitutes --memory when no databases were found', () => {
    const args = childArgs([], 4321, '/ext/tok/')
    expect(args[0]).toBe('--memory')
    expect(args).not.toContain('undefined')
  })
})

describe('baseUrlFor', () => {
  it('appends the db mount to the public base', () => {
    expect(baseUrlFor('/ext/tok/')).toBe('/ext/tok/db/')
  })
})

describe('childEnv', () => {
  it('strips Cate-internal vars but passes the rest through', () => {
    const env = childEnv({
      PATH: '/usr/bin',
      CATE_TOKEN: 'secret',
      CATE_API: 'http://127.0.0.1:9',
      PORT: '1234',
      HOME: '/home/u',
    })
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/home/u')
    expect(env.CATE_TOKEN).toBeUndefined()
    expect(env.CATE_API).toBeUndefined()
    expect(env.PORT).toBeUndefined()
  })
})
