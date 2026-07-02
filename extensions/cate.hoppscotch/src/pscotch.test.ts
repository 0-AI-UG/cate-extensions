import { describe, it, expect } from 'vitest'
import {
  parseProxyRequest,
  buildTargetUrl,
  flattenHeaders,
  successBody,
  errorBody,
  greetingBody,
} from './pscotch'

describe('parseProxyRequest', () => {
  it('parses a minimal valid request', () => {
    const r = parseProxyRequest(JSON.stringify({ method: 'get', url: 'https://api.example.com/x' }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.req.method).toBe('GET')
    expect(r.req.url).toBe('https://api.example.com/x')
    expect(r.req.headers).toEqual({})
    expect(r.req.wantsBinary).toBe(false)
    expect(r.req.auth).toBeNull()
  })

  it('carries headers, params, data, wantsBinary and auth through', () => {
    const r = parseProxyRequest(
      JSON.stringify({
        method: 'POST',
        url: 'http://h/x',
        headers: { 'X-A': '1' },
        params: { q: 'v' },
        data: '{"a":1}',
        wantsBinary: true,
        auth: { username: 'u', password: 'p' },
      }),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.req.headers).toEqual({ 'X-A': '1' })
    expect(r.req.params).toEqual({ q: 'v' })
    expect(r.req.data).toBe('{"a":1}')
    expect(r.req.wantsBinary).toBe(true)
    expect(r.req.auth).toEqual({ username: 'u', password: 'p' })
  })

  it('rejects missing method/url, bad JSON and non-objects', () => {
    expect(parseProxyRequest('').ok).toBe(false)
    expect(parseProxyRequest('not json').ok).toBe(false)
    expect(parseProxyRequest('[1,2]').ok).toBe(false)
    expect(parseProxyRequest(JSON.stringify({ url: 'http://h' })).ok).toBe(false)
    expect(parseProxyRequest(JSON.stringify({ method: 'GET' })).ok).toBe(false)
  })

  it('rejects non-http(s) targets (no file:// springboard)', () => {
    const r = parseProxyRequest(JSON.stringify({ method: 'GET', url: 'file:///etc/passwd' }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.message).toContain('destination')
  })

  it('ignores incomplete auth', () => {
    const r = parseProxyRequest(
      JSON.stringify({ method: 'GET', url: 'http://h/', auth: { username: 'u', password: '' } }),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.req.auth).toBeNull()
  })
})

describe('buildTargetUrl', () => {
  it('merges params into the query, params winning on duplicates', () => {
    const r = parseProxyRequest(
      JSON.stringify({ method: 'GET', url: 'http://h/p?a=1&b=2', params: { b: '3', c: '4' } }),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const u = new URL(buildTargetUrl(r.req))
    expect(u.searchParams.get('a')).toBe('1')
    expect(u.searchParams.get('b')).toBe('3')
    expect(u.searchParams.get('c')).toBe('4')
  })
})

describe('flattenHeaders', () => {
  it('lowercases names and takes the last of repeated values', () => {
    expect(flattenHeaders({ 'Content-Type': 'text/html', 'Set-Cookie': ['a=1', 'b=2'], gone: undefined })).toEqual({
      'content-type': 'text/html',
      'set-cookie': 'b=2',
    })
  })
})

describe('response bodies', () => {
  it('emits the proxyscotch success shape with text data', () => {
    const body = JSON.parse(
      successBody({
        status: 200,
        statusText: 'OK',
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from('{"ok":true}'),
        wantsBinary: false,
      }),
    )
    expect(body).toEqual({
      success: true,
      isBinary: false,
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
      data: '{"ok":true}',
    })
  })

  it('encodes binary data as UNPADDED base64 (Go RawStdEncoding parity)', () => {
    const body = JSON.parse(
      successBody({
        status: 200,
        statusText: 'OK',
        headers: {},
        body: Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x01]), // 5 bytes -> padded b64 would end in '='
        wantsBinary: true,
      }),
    )
    expect(body.isBinary).toBe(true)
    expect(body.data.endsWith('=')).toBe(false)
    expect(Buffer.from(body.data, 'base64')).toEqual(Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x01]))
  })

  it('formats errors and the greeting as the client expects', () => {
    expect(JSON.parse(errorBody('Invalid request.'))).toEqual({
      success: false,
      data: { message: '(Proxy Error) Invalid request.' },
    })
    const greeting = JSON.parse(greetingBody('fp-123'))
    expect(greeting.success).toBe(true)
    expect(greeting.data.sessionFingerprint).toBe('fp-123')
    expect(greeting.data.isProtected).toBe(false)
  })
})
