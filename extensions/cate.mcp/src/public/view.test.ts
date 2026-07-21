import { describe, expect, it } from 'vitest'
import { parseView, serializeView, type View } from './view'

describe('view (de)serialization', () => {
  it('defaults to Dashboard for an unset, legacy, or unparseable saved value', () => {
    expect(parseView(undefined)).toBeNull() // -> caller falls back to Dashboard
    expect(parseView('servers')).toBeNull() // legacy value
    expect(parseView('garbage')).toBeNull()
    expect(parseView(42)).toBeNull()
  })

  it('restores an explicitly-saved selection', () => {
    expect(parseView('dashboard')).toEqual({ kind: 'dashboard' })
    expect(parseView('discover')).toEqual({ kind: 'discover' })
    expect(parseView('endpoint')).toEqual({ kind: 'endpoint' })
    expect(parseView('server:linear')).toEqual({ kind: 'server', name: 'linear' })
  })

  it('round-trips through serializeView', () => {
    const views: View[] = [
      { kind: 'dashboard' },
      { kind: 'discover' },
      { kind: 'endpoint' },
      { kind: 'server', name: 'fs' },
    ]
    for (const v of views) expect(parseView(serializeView(v))).toEqual(v)
  })
})
