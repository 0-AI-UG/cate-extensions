import { describe, expect, it } from 'vitest'
import { createTtlCache } from './cache'

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('createTtlCache', () => {
  it('serves the cached value while fresh', async () => {
    let now = 0
    let loads = 0
    const cache = createTtlCache(async () => ++loads, 1000, () => now)
    expect(await cache.get()).toBe(1)
    now = 999
    expect(await cache.get()).toBe(1)
    expect(loads).toBe(1)
  })

  it('serves stale data immediately and revalidates in the background', async () => {
    let now = 0
    let loads = 0
    const cache = createTtlCache(async () => ++loads, 1000, () => now)
    expect(await cache.get()).toBe(1)
    now = 5000
    expect(await cache.get()).toBe(1) // stale served, reload kicked off
    await settle()
    expect(await cache.get()).toBe(2) // background reload landed
    expect(loads).toBe(2)
  })

  it('dedupes concurrent loads into one in-flight promise', async () => {
    let loads = 0
    let release!: (v: number) => void
    const cache = createTtlCache(
      () =>
        new Promise<number>((resolve) => {
          loads++
          release = resolve
        }),
      1000,
      () => 0,
    )
    const a = cache.get()
    const b = cache.get()
    release(42)
    expect(await a).toBe(42)
    expect(await b).toBe(42)
    expect(loads).toBe(1)
  })

  it('invalidate forces the next get() to block for a fresh load', async () => {
    let loads = 0
    const cache = createTtlCache(async () => ++loads, 1_000_000, () => 0)
    expect(await cache.get()).toBe(1)
    cache.invalidate()
    expect(cache.loadedAt()).toBeNull()
    expect(await cache.get()).toBe(2)
  })

  it('a failed initial load caches nothing and the next get() retries', async () => {
    let calls = 0
    const cache = createTtlCache(
      async () => {
        calls++
        if (calls === 1) throw new Error('boom')
        return 'ok'
      },
      1000,
      () => 0,
    )
    await expect(cache.get()).rejects.toThrow('boom')
    expect(await cache.get()).toBe('ok')
    expect(cache.loadedAt()).toBe(0)
  })

  it('a failed background revalidation keeps serving the stale value', async () => {
    let now = 0
    let calls = 0
    const cache = createTtlCache(
      async () => {
        calls++
        if (calls > 1) throw new Error('flaky')
        return 'first'
      },
      1000,
      () => now,
    )
    expect(await cache.get()).toBe('first')
    now = 5000
    expect(await cache.get()).toBe('first') // stale served; background load fails
    await settle()
    expect(await cache.get()).toBe('first') // still served, another retry queued
    expect(calls).toBeGreaterThanOrEqual(2)
  })
})
