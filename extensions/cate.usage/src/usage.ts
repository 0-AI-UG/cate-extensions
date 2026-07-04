// =============================================================================
// ccusage invocation for cate.usage.
//
// ccusage@18 (the last pure-JS release line; v19+ ships per-platform native
// binaries) is consumed as a LIBRARY: `ccusage/data-loader` exports the same
// loaders its CLI uses, and esbuild bundles them into dist/server.js, so the
// shipped artifact needs no node_modules, no npx, and no spawn.
//
// Pricing: costs come from token counts priced against LiteLLM's model table.
// A quick upfront probe of that table decides the mode: reachable -> loaders
// fetch the live table (correct prices for models newer than the pinned
// ccusage); unreachable -> straight to ccusage's bundled offline table (no
// 15s+ stall waiting out the loaders' own fetch) and the report is flagged
// `pricingSource: "offline"` so the panel can say costs may be incomplete.
// mode "auto" prefers each entry's precomputed costUSD when the JSONL has one.
//
// The load reports REAL progress via an optional callback: scan (glob the
// JSONL files, yielding a file count), pricing (the probe), read (the actual
// loaders, with the previous read's duration as an ETA).
// =============================================================================

import {
  getClaudePaths,
  globUsageFiles,
  loadDailyUsageData,
  loadMonthlyUsageData,
  loadSessionData,
} from 'ccusage/data-loader'
import type { DailyRow, MonthlyRow, RawUsage, SessionRow } from './shape'

/** The table ccusage@18 fetches for online pricing; probed (HEAD) upfront. */
const LITELLM_PRICING_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
const PRICING_PROBE_TIMEOUT_MS = 5_000

/** Progress of an in-flight load. `phaseStartedAt` restarts per phase so the
 *  consumer can show elapsed time; `readEtaMs` is the previous read's measured
 *  duration (null on the first load of this process). */
export interface LoadProgress {
  phase: 'scan' | 'pricing' | 'read'
  files: number | null
  offline: boolean | null
  /** True when an online read failed and the offline re-read is running. */
  retry: boolean
  phaseStartedAt: number
  readEtaMs: number | null
}

export type ProgressFn = (p: LoadProgress) => void

/** Duration of the last successful read phase, the next load's ETA. */
let lastReadMs: number | null = null

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

/** Can the live pricing table be reached? Fast no on offline machines. */
async function probeOnlinePricing(): Promise<boolean> {
  if (typeof fetch !== 'function') return false
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), PRICING_PROBE_TIMEOUT_MS)
  try {
    const res = await fetch(LITELLM_PRICING_URL, { method: 'HEAD', signal: ctl.signal })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

async function loadAll(offline: boolean): Promise<Omit<RawUsage, 'claudePaths' | 'pricingSource'>> {
  const options = { mode: 'auto' as const, offline, order: 'asc' as const }
  const [daily, sessions, monthly] = await Promise.all([
    loadDailyUsageData(options),
    loadSessionData(options),
    loadMonthlyUsageData(options),
  ])
  // ccusage's rows are supersets of the structural types shape.ts consumes.
  return {
    daily: daily as unknown as DailyRow[],
    sessions: sessions as unknown as SessionRow[],
    monthly: monthly as unknown as MonthlyRow[],
  }
}

/** Load everything ccusage knows. Never rejects: no Claude data dir resolves to
 *  the empty RawUsage (the panel renders the friendly empty state from it). */
export async function loadUsage(onProgress?: ProgressFn): Promise<RawUsage> {
  const snap: LoadProgress = {
    phase: 'scan',
    files: null,
    offline: null,
    retry: false,
    phaseStartedAt: Date.now(),
    readEtaMs: lastReadMs,
  }
  const emit = (patch: Partial<LoadProgress>): void => {
    Object.assign(snap, patch, { phaseStartedAt: Date.now() })
    onProgress?.({ ...snap })
  }

  let claudePaths: string[] = []
  try {
    claudePaths = getClaudePaths()
  } catch {
    // ccusage throws a guidance error when neither ~/.claude/projects nor
    // ~/.config/claude/projects (nor CLAUDE_CONFIG_DIR) exists.
    return { claudePaths: [], pricingSource: 'none', daily: [], sessions: [], monthly: [] }
  }

  emit({ phase: 'scan' })
  try {
    snap.files = (await globUsageFiles(claudePaths)).length
  } catch {
    /* the count is informational; the loaders glob for themselves */
  }

  emit({ phase: 'pricing' })
  const online = await probeOnlinePricing()

  emit({ phase: 'read', offline: !online })
  let readStart = Date.now()
  if (!online) {
    const rows = await loadAll(true)
    lastReadMs = Date.now() - readStart
    return { claudePaths, pricingSource: 'offline', ...rows }
  }
  try {
    // The probe said online, but the loaders' own table fetch can still hang;
    // guard generously (reads themselves can be slow on long histories).
    const guardMs = Math.max(30_000, (lastReadMs ?? 10_000) * 3)
    const rows = await withTimeout(loadAll(false), guardMs, 'online pricing load')
    lastReadMs = Date.now() - readStart
    return { claudePaths, pricingSource: 'online', ...rows }
  } catch (err) {
    console.warn(
      `cate.usage: online pricing load failed (${err instanceof Error ? err.message : String(err)}); retrying with bundled offline pricing`,
    )
    emit({ phase: 'read', offline: true, retry: true })
    readStart = Date.now()
    const rows = await loadAll(true)
    lastReadMs = Date.now() - readStart
    return { claudePaths, pricingSource: 'offline', ...rows }
  }
}

/** Local calendar date (YYYY-MM-DD) in the server's timezone, matching how
 *  ccusage buckets its daily rows by default. */
export function localToday(nowMs: number = Date.now()): string {
  const d = new Date(nowMs)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
