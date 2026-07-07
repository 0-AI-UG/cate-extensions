import { describe, expect, it } from 'vitest'
import { ActivityLog } from './activity'

function entry(tool: string, isError = false) {
  return { at: Date.now(), server: 's', tool, durationMs: 1, isError }
}

describe('ActivityLog', () => {
  it('bounds the ring to 200 entries, dropping the oldest', () => {
    const log = new ActivityLog()
    for (let i = 0; i < 250; i++) log.record(entry(`t${i}`))
    const recent = log.recent()
    expect(recent.length).toBe(200)
    // newest-first: t249 first, oldest surviving is t50 (t0..t49 evicted)
    expect(recent[0].tool).toBe('t249')
    expect(recent[recent.length - 1].tool).toBe('t50')
  })

  it('recent() is newest-first and honors the limit', () => {
    const log = new ActivityLog()
    log.record(entry('a'))
    log.record(entry('b'))
    log.record(entry('c'))
    expect(log.recent().map((e) => e.tool)).toEqual(['c', 'b', 'a'])
    expect(log.recent(2).map((e) => e.tool)).toEqual(['c', 'b'])
  })

  it('summary() counts totals and errors over the ring', () => {
    const log = new ActivityLog()
    log.record(entry('a'))
    log.record(entry('b', true))
    log.record(entry('c', true))
    expect(log.summary()).toEqual({ total: 3, errors: 2 })
  })
})
