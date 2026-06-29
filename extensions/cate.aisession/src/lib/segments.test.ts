import { describe, it, expect } from 'vitest'
import { extractSegments } from './segments'

describe('extractSegments', () => {
  it('splits prose followed by an appended JSON blob', () => {
    const text =
      'Workspace state below. read_terminal anything worth a closer look.\n\n' +
      '{"branch":"main","changedFiles":[".gitignore"],"openPanels":[{"type":"terminal","title":"Terminal 1"}]}'
    const segs = extractSegments(text)
    expect(segs.map((s) => s.kind)).toEqual(['text', 'json'])
    expect(segs[0]).toMatchObject({ kind: 'text' })
    expect((segs[0] as { text: string }).text).toContain('Workspace state below')
    expect(segs[1]).toMatchObject({ kind: 'json' })
    expect((segs[1] as { value: { branch: string } }).value.branch).toBe('main')
  })

  it('treats a whole-JSON message as one json segment', () => {
    const segs = extractSegments('{"a":1,"b":[1,2,3],"c":"hello world here"}')
    expect(segs).toHaveLength(1)
    expect(segs[0].kind).toBe('json')
  })

  it('leaves plain prose untouched', () => {
    const segs = extractSegments('Just a normal sentence with no payload.')
    expect(segs).toEqual([{ kind: 'text', text: 'Just a normal sentence with no payload.' }])
  })

  it('does not lift a short inline object', () => {
    const segs = extractSegments('set {x:1}')
    expect(segs).toEqual([{ kind: 'text', text: 'set {x:1}' }])
  })

  it('ignores braces inside strings when balancing', () => {
    const segs = extractSegments('before {"msg":"a } b { c with extra padding text","n":12345} after')
    expect(segs.map((s) => s.kind)).toEqual(['text', 'json', 'text'])
    expect((segs[0] as { text: string }).text).toBe('before ')
    expect((segs[2] as { text: string }).text).toBe(' after')
  })
})
