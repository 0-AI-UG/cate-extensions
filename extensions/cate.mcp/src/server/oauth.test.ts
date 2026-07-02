import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { AuthStore, FileOAuthProvider, PendingAuthRegistry, ensureGitignored } from './oauth'

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-mcp-oauth-'))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('AuthStore', () => {
  it('round-trips tokens per server and never touches mcp.json', () => {
    const store = new AuthStore(tmp)
    store.patch('remote-a', { tokens: { access_token: 'at', token_type: 'Bearer' } })
    store.patch('remote-b', { codeVerifier: 'ver' })
    expect(store.get('remote-a').tokens?.access_token).toBe('at')
    expect(store.get('remote-b').codeVerifier).toBe('ver')
    expect(store.get('missing')).toEqual({})
    expect(fs.existsSync(path.join(tmp, '.cate', 'mcp.json'))).toBe(false)
  })

  it('writes the auth file with mode 0600', () => {
    const store = new AuthStore(tmp)
    store.patch('s', { codeVerifier: 'v' })
    const mode = fs.statSync(store.file).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('clear scopes and remove behave', () => {
    const store = new AuthStore(tmp)
    store.patch('s', {
      tokens: { access_token: 'at', token_type: 'Bearer' },
      codeVerifier: 'v',
      clientInformation: { client_id: 'cid' },
    })
    store.clear('s', 'tokens')
    expect(store.get('s').tokens).toBeUndefined()
    expect(store.get('s').clientInformation?.client_id).toBe('cid')
    store.remove('s')
    expect(store.get('s')).toEqual({})
  })

  it('treats a corrupt auth file as empty (safe re-auth direction)', () => {
    const store = new AuthStore(tmp)
    store.patch('s', { codeVerifier: 'v' })
    fs.writeFileSync(store.file, '{corrupt')
    expect(store.get('s')).toEqual({})
    store.patch('s', { codeVerifier: 'v2' }) // rewrites cleanly
    expect(store.get('s').codeVerifier).toBe('v2')
  })
})

describe('ensureGitignored', () => {
  it('creates .cate/.gitignore with mcp-auth.json', () => {
    const cateDir = path.join(tmp, '.cate')
    fs.mkdirSync(cateDir)
    ensureGitignored(cateDir)
    expect(fs.readFileSync(path.join(cateDir, '.gitignore'), 'utf8')).toBe('mcp-auth.json\n')
  })

  it('appends once and is idempotent, preserving existing lines', () => {
    const cateDir = path.join(tmp, '.cate')
    fs.mkdirSync(cateDir)
    fs.writeFileSync(path.join(cateDir, '.gitignore'), 'session.json')
    ensureGitignored(cateDir)
    ensureGitignored(cateDir)
    ensureGitignored(cateDir)
    expect(fs.readFileSync(path.join(cateDir, '.gitignore'), 'utf8')).toBe('session.json\nmcp-auth.json\n')
  })

  it('a save through AuthStore also gitignores the file', () => {
    new AuthStore(tmp).patch('s', { codeVerifier: 'v' })
    const text = fs.readFileSync(path.join(tmp, '.cate', '.gitignore'), 'utf8')
    expect(text.split('\n')).toContain('mcp-auth.json')
  })
})

describe('PendingAuthRegistry', () => {
  it('issues unique single-use states mapping back to the server', () => {
    const reg = new PendingAuthRegistry()
    const s1 = reg.issue('server-a')
    const s2 = reg.issue('server-a')
    expect(s1).not.toBe(s2)
    expect(reg.consume(s1)).toBe('server-a')
    expect(reg.consume(s1)).toBeNull() // single use
    expect(reg.consume('made-up')).toBeNull()
  })
})

describe('FileOAuthProvider', () => {
  function provider(onUrl: (u: string) => void = () => undefined) {
    const store = new AuthStore(tmp)
    const registry = new PendingAuthRegistry()
    return {
      store,
      registry,
      provider: new FileOAuthProvider(store, 'remote-a', 'http://127.0.0.1:9999/oauth/callback', {
        registry,
        onAuthorizationUrl: onUrl,
      }),
    }
  }

  it('persists tokens, client info and code verifier through the SDK hooks', async () => {
    const { provider: p, store } = provider()
    await p.saveTokens({ access_token: 'at', token_type: 'Bearer', refresh_token: 'rt' })
    await p.saveClientInformation({ client_id: 'cid' })
    await p.saveCodeVerifier('pkce-ver')
    expect(await p.tokens()).toMatchObject({ access_token: 'at', refresh_token: 'rt' })
    expect(await p.clientInformation()).toMatchObject({ client_id: 'cid' })
    expect(await p.codeVerifier()).toBe('pkce-ver')
    // Directly visible in the store (same file another provider instance reads).
    expect(store.get('remote-a').tokens?.access_token).toBe('at')
  })

  it('codeVerifier throws when nothing was saved (flow must restart)', () => {
    const { provider: p } = provider()
    expect(() => p.codeVerifier()).toThrow(/verifier/)
  })

  it('captures the authorization URL instead of redirecting, and registers state', () => {
    let captured: string | null = null
    const { provider: p, registry } = provider((u) => (captured = u))
    const state = p.state()
    p.redirectToAuthorization(new URL(`https://auth.example.com/authorize?state=${state}`))
    expect(captured).toContain('https://auth.example.com/authorize')
    expect(registry.consume(state)).toBe('remote-a')
  })

  it('invalidateCredentials clears the requested scope', async () => {
    const { provider: p } = provider()
    await p.saveTokens({ access_token: 'at', token_type: 'Bearer' })
    await p.saveCodeVerifier('v')
    p.invalidateCredentials('tokens')
    expect(await p.tokens()).toBeUndefined()
    expect(await p.codeVerifier()).toBe('v')
    p.invalidateCredentials('all')
    expect(() => p.codeVerifier()).toThrow()
  })

  it('exposes redirect URL and public-client metadata', () => {
    const { provider: p } = provider()
    expect(p.redirectUrl).toBe('http://127.0.0.1:9999/oauth/callback')
    expect(p.clientMetadata.redirect_uris).toEqual(['http://127.0.0.1:9999/oauth/callback'])
    expect(p.clientMetadata.token_endpoint_auth_method).toBe('none')
  })
})
