// =============================================================================
// Stale-while-revalidate TTL cache for the (expensive) ccusage load: every
// JSONL file under ~/.claude/projects is re-read per load (tens of seconds on
// a long history), so panel polling must never block on, or fan out into,
// repeated scans.
//
//   - fresh value            -> returned as-is
//   - stale value            -> returned immediately, one background reload
//   - no value yet           -> callers await the (single, shared) load
//   - invalidate() + get()   -> explicit refresh: next get() blocks for fresh
//
// Pure (clock injected) so cache.test.ts can drive it deterministically.
// =============================================================================

export interface TtlCache<T> {
  /** Cached value (fresh or stale-with-background-reload), loading when empty.
   *  Concurrent callers share one in-flight load. */
  get(): Promise<T>
  /** Drop the cached value; the next get() blocks for a fresh load. */
  invalidate(): void
  /** Timestamp (ms) of the cached value, or null when empty. */
  loadedAt(): number | null
}

export function createTtlCache<T>(
  load: () => Promise<T>,
  ttlMs: number,
  now: () => number = Date.now,
): TtlCache<T> {
  let value: { data: T; at: number } | null = null
  let inflight: Promise<T> | null = null

  function startLoad(): Promise<T> {
    if (!inflight) {
      inflight = load().then(
        (data) => {
          value = { data, at: now() }
          inflight = null
          return data
        },
        (err) => {
          // A failed load caches nothing; the next get() retries.
          inflight = null
          throw err
        },
      )
    }
    return inflight
  }

  return {
    async get(): Promise<T> {
      if (value && now() - value.at < ttlMs) return value.data
      if (value) {
        // Stale: serve it now, revalidate in the background. A background
        // failure only logs; the stale value stays served and a later get()
        // retries.
        startLoad().catch((err) => {
          console.warn(
            `ttl-cache: background reload failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        })
        return value.data
      }
      return startLoad()
    },
    invalidate(): void {
      value = null
    },
    loadedAt(): number | null {
      return value ? value.at : null
    },
  }
}
