import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createAutosaver } from './autosave'
import {
  DEFAULT_OPTIONS,
  DEFAULT_SOURCE,
  DEFAULT_SPLIT,
  SPLIT_MAX,
  SPLIT_MIN,
  clampSplit,
  mermaidThemeFromHost,
  renderErrorMessage,
  resolveMermaidTheme,
  sanitizeStoredOptions,
  sanitizeStoredSource,
  sanitizeStoredSplit,
} from './state'

describe('mermaidThemeFromHost', () => {
  it('maps a light host theme to mermaid default', () => {
    expect(mermaidThemeFromHost({ id: 'x', type: 'light', app: {}, terminal: {} })).toBe('default')
  })

  it('maps everything else to mermaid dark', () => {
    expect(mermaidThemeFromHost({ id: 'x', type: 'dark', app: {}, terminal: {} })).toBe('dark')
    expect(mermaidThemeFromHost(undefined)).toBe('dark')
    expect(mermaidThemeFromHost(null)).toBe('dark')
    expect(mermaidThemeFromHost({ type: 'LIGHT' })).toBe('dark')
    expect(mermaidThemeFromHost('light')).toBe('dark')
  })
})

describe('resolveMermaidTheme', () => {
  it('an explicit pick wins regardless of the host theme', () => {
    expect(resolveMermaidTheme('forest', { type: 'dark' })).toBe('forest')
    expect(resolveMermaidTheme('neutral', { type: 'light' })).toBe('neutral')
    expect(resolveMermaidTheme('dark', { type: 'light' })).toBe('dark')
  })

  it('auto follows the host palette', () => {
    expect(resolveMermaidTheme('auto', { type: 'light' })).toBe('default')
    expect(resolveMermaidTheme('auto', { type: 'dark' })).toBe('dark')
    expect(resolveMermaidTheme('auto', undefined)).toBe('dark')
  })
})

describe('sanitizeStoredOptions', () => {
  it('restores a stored theme pick', () => {
    expect(sanitizeStoredOptions({ theme: 'forest' })).toEqual({ theme: 'forest' })
  })

  it('drops fields from older versions and unrecognized themes', () => {
    expect(sanitizeStoredOptions({ theme: 'dark', look: 'handDrawn' })).toEqual({ theme: 'dark' })
    expect(sanitizeStoredOptions({ theme: 'neon' })).toEqual(DEFAULT_OPTIONS)
  })

  it('falls back to all defaults for foreign payloads', () => {
    expect(sanitizeStoredOptions(undefined)).toEqual(DEFAULT_OPTIONS)
    expect(sanitizeStoredOptions(null)).toEqual(DEFAULT_OPTIONS)
    expect(sanitizeStoredOptions('dark')).toEqual(DEFAULT_OPTIONS)
    expect(sanitizeStoredOptions(['dark'])).toEqual(DEFAULT_OPTIONS)
  })

  it('never returns the shared DEFAULT_OPTIONS object (mutation safety)', () => {
    expect(sanitizeStoredOptions(undefined)).not.toBe(DEFAULT_OPTIONS)
  })
})

describe('split ratio', () => {
  it('clamps to the allowed range', () => {
    expect(clampSplit(0.5)).toBe(0.5)
    expect(clampSplit(0)).toBe(SPLIT_MIN)
    expect(clampSplit(1)).toBe(SPLIT_MAX)
  })

  it('restores a stored ratio, clamped', () => {
    expect(sanitizeStoredSplit(0.6)).toBe(0.6)
    expect(sanitizeStoredSplit(0.01)).toBe(SPLIT_MIN)
    expect(sanitizeStoredSplit(2)).toBe(SPLIT_MAX)
  })

  it('returns null (use the default) for unusable values', () => {
    expect(sanitizeStoredSplit(undefined)).toBeNull()
    expect(sanitizeStoredSplit(null)).toBeNull()
    expect(sanitizeStoredSplit('0.5')).toBeNull()
    expect(sanitizeStoredSplit(NaN)).toBeNull()
    expect(sanitizeStoredSplit(Infinity)).toBeNull()
  })

  it('the default split is itself within the clamp range', () => {
    expect(clampSplit(DEFAULT_SPLIT)).toBe(DEFAULT_SPLIT)
  })
})

describe('sanitizeStoredSource', () => {
  it('restores a stored source string verbatim', () => {
    const src = 'flowchart LR\n  a --> b\n'
    expect(sanitizeStoredSource(src)).toBe(src)
  })

  it('returns null (use the default example) when nothing usable is stored', () => {
    expect(sanitizeStoredSource(undefined)).toBeNull()
    expect(sanitizeStoredSource(null)).toBeNull()
    expect(sanitizeStoredSource('')).toBeNull()
    expect(sanitizeStoredSource('   \n\t ')).toBeNull()
    expect(sanitizeStoredSource(42)).toBeNull()
    expect(sanitizeStoredSource({ source: 'flowchart' })).toBeNull()
    expect(sanitizeStoredSource(['flowchart'])).toBeNull()
  })

  it('the default example is itself restorable', () => {
    expect(sanitizeStoredSource(DEFAULT_SOURCE)).toBe(DEFAULT_SOURCE)
  })
})

describe('save/load round-trip (autosaver -> panel storage -> restore)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('a debounced save round-trips through the storage payload', () => {
    // Fake of cate.storage.panel: a plain KV map, as the host persists it.
    const store = new Map<string, unknown>()
    const saver = createAutosaver((src) => store.set('source', src), 700)

    const edited = 'sequenceDiagram\n  A->>B: hello\n'
    saver.schedule(() => 'intermediate edit')
    saver.schedule(() => edited)
    vi.advanceTimersByTime(700)

    expect(store.get('source')).toBe(edited)
    expect(sanitizeStoredSource(store.get('source'))).toBe(edited)
  })

  it('flush on hide persists edits still inside the debounce window', () => {
    const store = new Map<string, unknown>()
    const saver = createAutosaver((src) => store.set('source', src), 700)

    saver.schedule(() => 'graph TD; a-->b')
    vi.advanceTimersByTime(100) // panel closes before the debounce fires
    saver.flush()

    expect(sanitizeStoredSource(store.get('source'))).toBe('graph TD; a-->b')
  })

  it('a corrupted stored payload falls back to the default example', () => {
    const store = new Map<string, unknown>()
    store.set('source', { hand: 'edited' }) // foreign shape in storage.json
    const restored = sanitizeStoredSource(store.get('source')) ?? DEFAULT_SOURCE
    expect(restored).toBe(DEFAULT_SOURCE)
  })
})

describe('renderErrorMessage', () => {
  it('uses the message of a mermaid parse error', () => {
    const err = new Error('Parse error on line 2:\n...expecting NODE_STRING')
    expect(renderErrorMessage(err)).toBe('Parse error on line 2:\n...expecting NODE_STRING')
  })

  it('passes through a non-empty string throw', () => {
    expect(renderErrorMessage('boom')).toBe('boom')
  })

  it('falls back to a generic message for anything unusable', () => {
    expect(renderErrorMessage(new Error(''))).toBe('Diagram failed to render.')
    expect(renderErrorMessage(new Error('   '))).toBe('Diagram failed to render.')
    expect(renderErrorMessage(undefined)).toBe('Diagram failed to render.')
    expect(renderErrorMessage(null)).toBe('Diagram failed to render.')
    expect(renderErrorMessage({ hash: {} })).toBe('Diagram failed to render.')
    expect(renderErrorMessage('')).toBe('Diagram failed to render.')
  })
})
