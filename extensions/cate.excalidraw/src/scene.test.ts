import { describe, it, expect } from 'vitest'
import { sanitizeStoredScene, themeFromHost } from './scene'

describe('themeFromHost', () => {
  it('maps a light host theme', () => {
    expect(themeFromHost({ id: 'x', type: 'light', app: {}, terminal: {} })).toBe('light')
  })

  it('defaults to dark for anything else', () => {
    expect(themeFromHost({ id: 'x', type: 'dark', app: {}, terminal: {} })).toBe('dark')
    expect(themeFromHost(undefined)).toBe('dark')
    expect(themeFromHost(null)).toBe('dark')
    expect(themeFromHost({ type: 'LIGHT' })).toBe('dark')
    expect(themeFromHost('light')).toBe('dark')
  })
})

describe('sanitizeStoredScene', () => {
  it('restores a well-formed stored scene', () => {
    const raw = JSON.stringify({
      elements: [{ id: 'a', type: 'rectangle' }],
      appState: { viewBackgroundColor: '#fff' },
      files: { f1: { mimeType: 'image/png' } },
    })
    expect(sanitizeStoredScene(raw)).toEqual({
      elements: [{ id: 'a', type: 'rectangle' }],
      appState: { viewBackgroundColor: '#fff' },
      files: { f1: { mimeType: 'image/png' } },
      scrollToContent: true,
    })
  })

  it('returns undefined (empty board) when nothing usable is stored', () => {
    expect(sanitizeStoredScene(undefined)).toBeUndefined()
    expect(sanitizeStoredScene(null)).toBeUndefined()
    expect(sanitizeStoredScene('')).toBeUndefined()
    expect(sanitizeStoredScene(42)).toBeUndefined()
    expect(sanitizeStoredScene({ elements: [] })).toBeUndefined() // not a string
  })

  it('returns undefined for corrupt or non-object JSON', () => {
    expect(sanitizeStoredScene('{not json')).toBeUndefined()
    expect(sanitizeStoredScene('null')).toBeUndefined()
    expect(sanitizeStoredScene('"a string"')).toBeUndefined()
    expect(sanitizeStoredScene('[1,2,3]')).toBeUndefined()
  })

  it('coerces schema-mismatched fields instead of crashing', () => {
    const raw = JSON.stringify({ elements: 5, appState: 'nope', files: [] })
    expect(sanitizeStoredScene(raw)).toEqual({
      elements: [],
      appState: {},
      files: undefined,
      scrollToContent: true,
    })
  })

  it('drops non-object entries inside elements', () => {
    const raw = JSON.stringify({ elements: [{ id: 'a' }, null, 'junk', 7, [1]] })
    expect(sanitizeStoredScene(raw)?.elements).toEqual([{ id: 'a' }])
  })

  it('strips appState.collaborators (plain object would crash Excalidraw)', () => {
    const raw = JSON.stringify({
      elements: [],
      appState: { collaborators: { peer: {} }, zenModeEnabled: true },
    })
    expect(sanitizeStoredScene(raw)?.appState).toEqual({ zenModeEnabled: true })
  })
})
