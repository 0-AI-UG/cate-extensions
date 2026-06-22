import { describe, it, expect } from 'vitest'
import { normalizeUpstream, resolveUpstream, parseCodeRef } from './config'

describe('normalizeUpstream', () => {
  it('defaults scheme to http and reduces to origin', () => {
    expect(normalizeUpstream('localhost:3000')).toBe('http://localhost:3000')
    expect(normalizeUpstream('http://localhost:3000/wiki/foo')).toBe('http://localhost:3000')
    expect(normalizeUpstream('https://wiki.example.com:8443/x?y=1')).toBe('https://wiki.example.com:8443')
  })

  it('trims whitespace', () => {
    expect(normalizeUpstream('  localhost:8001  ')).toBe('http://localhost:8001')
  })

  it('rejects non-string / empty / non-http schemes', () => {
    expect(normalizeUpstream('')).toBeNull()
    expect(normalizeUpstream('   ')).toBeNull()
    expect(normalizeUpstream(42 as unknown)).toBeNull()
    expect(normalizeUpstream('ftp://host')).toBeNull()
    expect(normalizeUpstream('file:///etc/passwd')).toBeNull()
  })
})

describe('resolveUpstream', () => {
  it('prefers stored, then env, then null', () => {
    expect(resolveUpstream({ stored: 'host:1', env: 'host:2' })).toBe('http://host:1')
    expect(resolveUpstream({ stored: undefined, env: 'host:2' })).toBe('http://host:2')
    expect(resolveUpstream({ stored: undefined, env: undefined })).toBeNull()
    // Invalid stored falls through to env.
    expect(resolveUpstream({ stored: 'not a url', env: 'host:9' })).toBe('http://host:9')
  })
})

describe('parseCodeRef', () => {
  it('parses #LNN, :NN, and ?line= forms', () => {
    expect(parseCodeRef('src/foo/bar.ts#L42')).toEqual({ path: 'src/foo/bar.ts', line: 42 })
    expect(parseCodeRef('/src/foo/bar.ts:42')).toEqual({ path: 'src/foo/bar.ts', line: 42 })
    expect(parseCodeRef('cate-open:src/x.ts?line=10')).toEqual({ path: 'src/x.ts', line: 10 })
    expect(parseCodeRef('src/x.ts#99')).toEqual({ path: 'src/x.ts', line: 99 })
  })

  it('parses a bare file path without a line', () => {
    expect(parseCodeRef('src/index.ts')).toEqual({ path: 'src/index.ts' })
    expect(parseCodeRef('lib/util/helpers.py')).toEqual({ path: 'lib/util/helpers.py' })
  })

  it('strips a leading slash to keep paths workspace-relative', () => {
    expect(parseCodeRef('/README.md')).toEqual({ path: 'README.md' })
  })

  it('rejects real URLs, anchors, and protocol schemes', () => {
    expect(parseCodeRef('https://github.com/x/y')).toBeNull()
    expect(parseCodeRef('http://localhost:3000/wiki')).toBeNull()
    expect(parseCodeRef('mailto:a@b.com')).toBeNull()
    expect(parseCodeRef('#section-heading')).toBeNull()
    expect(parseCodeRef('vscode://file/x')).toBeNull()
  })

  it('rejects path traversal and non-file-looking strings', () => {
    expect(parseCodeRef('../../etc/passwd')).toBeNull()
    expect(parseCodeRef('justaword')).toBeNull()
    expect(parseCodeRef('')).toBeNull()
    expect(parseCodeRef(null as unknown)).toBeNull()
  })

  it('does not mistake a Windows drive letter for a line number', () => {
    // Not a workspace-relative ref we route, but must not crash or mis-split.
    const ref = parseCodeRef('C:\\Users\\x\\file.ts')
    // Either null (absolute) is acceptable; what matters is no ":x" line split.
    if (ref) expect(ref.line).toBeUndefined()
  })
})
