import { describe, it, expect } from 'vitest'
import { normalizeUpstream, resolveUpstream, normalizePublicBase } from './config'

describe('normalizeUpstream', () => {
  it('normalizes to an origin', () => {
    expect(normalizeUpstream('http://localhost:3000')).toBe('http://localhost:3000')
    expect(normalizeUpstream('http://localhost:3000/some/path')).toBe('http://localhost:3000')
    expect(normalizeUpstream('https://hopp.example.com/')).toBe('https://hopp.example.com')
  })

  it('defaults the scheme to http for bare host:port', () => {
    expect(normalizeUpstream('localhost:3000')).toBe('http://localhost:3000')
    expect(normalizeUpstream('127.0.0.1:8080')).toBe('http://127.0.0.1:8080')
  })

  it('rejects non-http(s) schemes and garbage', () => {
    expect(normalizeUpstream('ftp://host')).toBeNull()
    expect(normalizeUpstream('file:///etc/passwd')).toBeNull()
    expect(normalizeUpstream('')).toBeNull()
    expect(normalizeUpstream('   ')).toBeNull()
    expect(normalizeUpstream(null)).toBeNull()
    expect(normalizeUpstream(123)).toBeNull()
  })
})

describe('resolveUpstream', () => {
  it('prefers stored over env', () => {
    expect(resolveUpstream({ stored: 'http://a:1', env: 'http://b:2' })).toBe('http://a:1')
  })

  it('falls back to env, then null', () => {
    expect(resolveUpstream({ stored: undefined, env: 'localhost:3000' })).toBe('http://localhost:3000')
    expect(resolveUpstream({ stored: undefined, env: undefined })).toBeNull()
  })
})

describe('normalizePublicBase', () => {
  it('accepts the proxied panel prefix shape', () => {
    expect(normalizePublicBase('/ext/a1b2c3d4/')).toBe('/ext/a1b2c3d4/')
    expect(normalizePublicBase('/')).toBe('/')
  })

  it('rejects malformed / hostile values', () => {
    expect(normalizePublicBase('ext/x/')).toBeNull()
    expect(normalizePublicBase('/ext/x')).toBeNull()
    expect(normalizePublicBase('/ext/../x/')).toBeNull()
    expect(normalizePublicBase('//evil.example/')).toBeNull()
    expect(normalizePublicBase('/ext/a"b/')).toBeNull()
    expect(normalizePublicBase(undefined)).toBeNull()
  })
})
