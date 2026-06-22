import { describe, it, expect } from 'vitest'
import {
  normalizeSearchResponse,
  normalizeBaseUrl,
  joinUrl,
  clampMatches,
} from './sourcebot'
import { authHeaders, rewriteLocation } from './sourcebotClient'

describe('normalizeSearchResponse', () => {
  it('flattens the Zoekt-shaped response into hits with repo/path/line/snippet', () => {
    const res = normalizeSearchResponse({
      stats: { totalMatchCount: 7 },
      files: [
        {
          fileName: { text: 'src/index.ts' },
          repository: 'acme/web',
          webUrl: 'https://sb/acme/web/-/blob/src/index.ts',
          language: 'TypeScript',
          chunks: [
            {
              content: { text: 'const x = 1\nconst y = 2' },
              contentStart: { lineNumber: 42 },
              matchRanges: [{ start: { lineNumber: 43, column: 7 }, end: { lineNumber: 43, column: 8 } }],
            },
          ],
        },
      ],
    })
    expect(res.totalMatches).toBe(7)
    expect(res.hits).toHaveLength(1)
    expect(res.hits[0]).toMatchObject({
      repository: 'acme/web',
      path: 'src/index.ts',
      // first match range's line wins over contentStart
      line: 43,
      language: 'TypeScript',
    })
    expect(res.hits[0].snippet).toContain('const x = 1')
  })

  it('falls back to contentStart line when there are no match ranges', () => {
    const res = normalizeSearchResponse({
      files: [
        {
          fileName: { text: 'a.go' },
          repository: 'r',
          chunks: [{ content: 'package main', contentStart: { lineNumber: 10 } }],
        },
      ],
    })
    expect(res.hits[0].line).toBe(10)
    expect(res.hits[0].snippet).toBe('package main')
  })

  it('tolerates a bare-string fileName and a lines[] chunk shape', () => {
    const res = normalizeSearchResponse({
      files: [
        {
          fileName: 'pkg/util.rs',
          repository: 'r2',
          chunks: [
            { lines: [{ content: 'fn main() {' }, { content: '}' }], startLineNumber: 3 },
          ],
        },
      ],
    })
    expect(res.hits[0].path).toBe('pkg/util.rs')
    expect(res.hits[0].line).toBe(3)
    expect(res.hits[0].snippet).toBe('fn main() {\n}')
  })

  it('emits one line-1 hit for a file match with no chunks', () => {
    const res = normalizeSearchResponse({
      files: [{ fileName: { text: 'README.md' }, repository: 'r' }],
    })
    expect(res.hits).toEqual([
      { repository: 'r', path: 'README.md', line: 1, snippet: '', webUrl: undefined, language: undefined },
    ])
  })

  it('never throws on garbage and returns an empty result', () => {
    expect(normalizeSearchResponse(null).hits).toEqual([])
    expect(normalizeSearchResponse('nope').hits).toEqual([])
    expect(normalizeSearchResponse({ files: 'oops' }).hits).toEqual([])
    expect(normalizeSearchResponse({ files: [null, 5, {}] }).hits).toEqual([])
  })

  it('reports truncation from isSearchExhaustive', () => {
    expect(normalizeSearchResponse({ isSearchExhaustive: false, files: [] }).truncated).toBe(true)
    expect(normalizeSearchResponse({ files: [] }).truncated).toBe(false)
  })
})

describe('normalizeBaseUrl', () => {
  it('strips a trailing slash and keeps origin', () => {
    expect(normalizeBaseUrl('https://sb.example.com/')).toBe('https://sb.example.com')
    expect(normalizeBaseUrl('  https://sb.example.com  ')).toBe('https://sb.example.com')
  })
  it('preserves a subpath prefix', () => {
    expect(normalizeBaseUrl('https://host/sourcebot/')).toBe('https://host/sourcebot')
  })
  it('rejects non-http(s) and empty', () => {
    expect(normalizeBaseUrl('ftp://x')).toBeNull()
    expect(normalizeBaseUrl('not a url')).toBeNull()
    expect(normalizeBaseUrl('')).toBeNull()
    expect(normalizeBaseUrl(undefined)).toBeNull()
  })
})

describe('joinUrl', () => {
  it('joins without doubling slashes', () => {
    expect(joinUrl('https://h', '/api/search')).toBe('https://h/api/search')
    expect(joinUrl('https://h/', 'api/search')).toBe('https://h/api/search')
    expect(joinUrl('https://h/sub', '/api/x')).toBe('https://h/sub/api/x')
  })
})

describe('clampMatches', () => {
  it('clamps into [1, max] with a fallback', () => {
    expect(clampMatches(undefined)).toBe(50)
    expect(clampMatches(0)).toBe(1)
    expect(clampMatches(99999)).toBe(200)
    expect(clampMatches(30)).toBe(30)
  })
})

describe('authHeaders', () => {
  it('sets both header forms when a key is present, none otherwise', () => {
    expect(authHeaders('secret')).toEqual({
      'X-Sourcebot-Api-Key': 'secret',
      Authorization: 'Bearer secret',
    })
    expect(authHeaders(undefined)).toEqual({})
  })
})

describe('rewriteLocation', () => {
  const base = 'https://sb.example.com'
  it('rewrites same-origin absolute redirects under /sb/', () => {
    expect(rewriteLocation('https://sb.example.com/search?q=x', base)).toBe('/sb/search?q=x')
  })
  it('rewrites bare-relative redirects', () => {
    expect(rewriteLocation('/login', base)).toBe('/sb/login')
  })
  it('leaves cross-origin redirects untouched', () => {
    expect(rewriteLocation('https://other.com/x', base)).toBe('https://other.com/x')
  })
})
