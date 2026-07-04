// =============================================================================
// Debounced autosave with an explicit flush (same pattern as cate.excalidraw).
// Serialization is deferred to save time (only the latest snapshot is ever
// serialized), and flush() lets the panel persist the last edits immediately
// on hide/close instead of losing whatever was still inside the debounce
// window. Also reused as the render debouncer: "write" is just a callback.
// =============================================================================

export interface Autosaver {
  /** Record the latest snapshot and (re)start the debounce timer. */
  schedule(serialize: () => string): void
  /** Persist the pending snapshot now, if any. Safe to call repeatedly. */
  flush(): void
}

export function createAutosaver(write: (payload: string) => void, delayMs: number): Autosaver {
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: (() => string) | undefined

  const flush = (): void => {
    clearTimeout(timer)
    timer = undefined
    if (!pending) return
    const serialize = pending
    pending = undefined
    try {
      write(serialize())
    } catch {
      /* a single failed autosave is not worth surfacing */
    }
  }

  return {
    schedule(serialize) {
      pending = serialize
      clearTimeout(timer)
      timer = setTimeout(flush, delayMs)
    },
    flush,
  }
}
