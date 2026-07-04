import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createAutosaver } from './autosave'

const DELAY = 700

describe('createAutosaver', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('debounces: only the latest snapshot is written, once', () => {
    const write = vi.fn()
    const saver = createAutosaver(write, DELAY)
    saver.schedule(() => 'v1')
    vi.advanceTimersByTime(DELAY - 1)
    saver.schedule(() => 'v2')
    vi.advanceTimersByTime(DELAY - 1)
    expect(write).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(write).toHaveBeenCalledExactlyOnceWith('v2')
  })

  it('flush() writes the pending snapshot immediately and cancels the timer', () => {
    const write = vi.fn()
    const saver = createAutosaver(write, DELAY)
    saver.schedule(() => 'v1')
    saver.flush()
    expect(write).toHaveBeenCalledExactlyOnceWith('v1')
    vi.advanceTimersByTime(DELAY * 2) // timer must not fire a second write
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('flush() with nothing pending is a no-op', () => {
    const write = vi.fn()
    const saver = createAutosaver(write, DELAY)
    saver.flush()
    saver.schedule(() => 'v1')
    vi.advanceTimersByTime(DELAY)
    saver.flush() // already written; nothing left to write
    expect(write).toHaveBeenCalledExactlyOnceWith('v1')
  })

  it('serialization is deferred until save time', () => {
    const write = vi.fn()
    const saver = createAutosaver(write, DELAY)
    const serialize = vi.fn(() => 'v1')
    saver.schedule(serialize)
    expect(serialize).not.toHaveBeenCalled()
    vi.advanceTimersByTime(DELAY)
    expect(serialize).toHaveBeenCalledTimes(1)
  })

  it('a throwing serializer or writer does not propagate and clears pending', () => {
    const write = vi.fn(() => {
      throw new Error('storage gone')
    })
    const saver = createAutosaver(write, DELAY)
    saver.schedule(() => 'v1')
    expect(() => saver.flush()).not.toThrow()
    saver.schedule(() => {
      throw new Error('serialize failed')
    })
    expect(() => vi.advanceTimersByTime(DELAY)).not.toThrow()
    saver.flush() // pending was consumed despite the throw
    expect(write).toHaveBeenCalledTimes(1)
  })
})
