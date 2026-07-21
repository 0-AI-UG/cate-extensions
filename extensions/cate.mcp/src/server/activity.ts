// A bounded ring buffer of tool calls that flowed through the aggregated /mcp
// endpoint, for the panel's Activity feed. Deliberately in-memory and lossy:
// the last N calls only, never persisted, and recording MUST NOT bump the
// manager serial (it is read on its own /api/activity poll, not /api/state).

import type { ActivityEntry } from '../shared/types'

const MAX_ENTRIES = 200

export class ActivityLog {
  private readonly entries: ActivityEntry[] = []

  constructor(private readonly max: number = MAX_ENTRIES) {}

  record(entry: ActivityEntry): void {
    this.entries.push(entry)
    if (this.entries.length > this.max) this.entries.shift()
  }

  /** Newest first; capped to `limit` when given. */
  recent(limit?: number): ActivityEntry[] {
    const newestFirst = this.entries.slice().reverse()
    return limit === undefined ? newestFirst : newestFirst.slice(0, limit)
  }

  summary(): { total: number; errors: number } {
    let errors = 0
    for (const e of this.entries) if (e.isError) errors++
    return { total: this.entries.length, errors }
  }
}
