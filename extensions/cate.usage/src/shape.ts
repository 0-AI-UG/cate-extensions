// =============================================================================
// Pure report shaping for cate.usage.
//
// Input: the raw rows ccusage's data-loader returns (structural subsets are
// typed below, matching ccusage@18 JSON). Output: the dashboard payload the
// panel renders. Everything here is deterministic (the caller passes "today"),
// touches no filesystem or network, and is covered by shape.test.ts against
// fixture ccusage JSON.
//
// Dates are ccusage's plain local-calendar strings (YYYY-MM-DD for days,
// YYYY-MM for months); all arithmetic happens in UTC on those strings so the
// server's timezone never shifts a bucket.
// =============================================================================

// --- ccusage row shapes (structural subset of ccusage@18 output) ----------------

export interface ModelBreakdown {
  modelName: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  cost: number
}

export interface TokenTotals {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
}

export interface DailyRow extends TokenTotals {
  date: string
  totalCost: number
  modelsUsed: string[]
  modelBreakdowns: ModelBreakdown[]
}

export interface SessionRow extends TokenTotals {
  sessionId: string
  projectPath: string
  totalCost: number
  lastActivity: string
  modelsUsed: string[]
}

export interface MonthlyRow extends TokenTotals {
  month: string
  totalCost: number
  modelsUsed?: string[]
}

// --- report shapes ---------------------------------------------------------------

export interface PeriodSummary {
  cost: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  days: number
}

export interface Summary {
  today: PeriodSummary
  thisWeek: PeriodSummary
  thisMonth: PeriodSummary
  /** Everything on disk. NOT all-time: agents purge their own transcripts
   *  (Claude Code deletes ~/.claude/projects entries older than
   *  `cleanupPeriodDays`, 30 by default), so this covers only what survived.
   *  Pair it with UsageReport.coverageStart when labelling. */
  retained: PeriodSummary
}

export interface DailyPoint {
  date: string
  cost: number
  totalTokens: number
}

export interface ModelRow extends TokenTotals {
  model: string
  cost: number
  totalTokens: number
  /** Fraction of the all-model cost, 0..1 (0 when the total cost is 0). */
  share: number
}

export interface SessionSummaryRow {
  sessionId: string
  /** Human-friendly session name derived from the id. */
  name: string
  lastActivity: string
  cost: number
  totalTokens: number
  modelsUsed: string[]
}

export interface MonthlySummaryRow {
  month: string
  cost: number
  totalTokens: number
}

export interface UsageReport {
  available: boolean
  /** Set when available=false: why there is nothing to show. */
  reason?: 'no-claude-data' | 'no-usage-entries'
  generatedAt: string
  today: string
  /** First day with usage on disk, or null when there is none. The summary's
   *  `retained` bucket spans coverageStart..today and nothing earlier. */
  coverageStart: string | null
  claudePaths: string[]
  pricingSource: 'online' | 'offline' | 'none'
  summary: Summary
  daily: DailyPoint[]
  models: ModelRow[]
  sessions: SessionSummaryRow[]
  monthly: MonthlySummaryRow[]
}

// --- date helpers (UTC string math on YYYY-MM-DD) --------------------------------

const DAY_MS = 86_400_000

function parseDay(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  return Date.UTC(y, (m || 1) - 1, d || 1)
}

function formatDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** iso + n calendar days (n may be negative). */
export function addDays(iso: string, n: number): string {
  return formatDay(parseDay(iso) + n * DAY_MS)
}

/** Monday of the ISO week containing `iso`. */
export function startOfWeek(iso: string): string {
  const ms = parseDay(iso)
  const weekday = new Date(ms).getUTCDay() // 0 Sun .. 6 Sat
  const sinceMonday = (weekday + 6) % 7
  return formatDay(ms - sinceMonday * DAY_MS)
}

/** First day of the calendar month containing `iso`. */
export function startOfMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`
}

// --- aggregation -----------------------------------------------------------------

export function totalTokensOf(row: TokenTotals): number {
  return row.inputTokens + row.outputTokens + row.cacheCreationTokens + row.cacheReadTokens
}

function sumPeriod(rows: DailyRow[]): PeriodSummary {
  const acc: PeriodSummary = { cost: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, days: 0 }
  for (const row of rows) {
    acc.cost += row.totalCost
    acc.totalTokens += totalTokensOf(row)
    acc.inputTokens += row.inputTokens
    acc.outputTokens += row.outputTokens
    acc.days += 1
  }
  return acc
}

/** Cost/token tiles: today, this ISO week (Mon..today), this calendar month,
 *  and all time. Rows dated after `today` (clock skew) are ignored. */
export function summarize(daily: DailyRow[], today: string): Summary {
  const upToToday = daily.filter((r) => r.date <= today)
  const week = startOfWeek(today)
  const month = startOfMonth(today)
  return {
    today: sumPeriod(upToToday.filter((r) => r.date === today)),
    thisWeek: sumPeriod(upToToday.filter((r) => r.date >= week)),
    thisMonth: sumPeriod(upToToday.filter((r) => r.date >= month)),
    retained: sumPeriod(upToToday),
  }
}

/** Earliest day with usage on disk (null when there is none) — the real start
 *  of the retained window, which the panel labels instead of "all time". */
export function coverageStartOf(daily: DailyRow[], today: string): string | null {
  let first: string | null = null
  for (const row of daily) {
    if (row.date > today) continue
    if (first === null || row.date < first) first = row.date
  }
  return first
}

/** The last `days` calendar days ending at `today`, zero-filled so the chart
 *  has one point per day even when nothing ran. */
export function dailySeries(daily: DailyRow[], today: string, days: number): DailyPoint[] {
  const byDate = new Map<string, DailyRow>()
  for (const row of daily) byDate.set(row.date, row)
  const out: DailyPoint[] = []
  for (let i = days - 1; i >= 0; i--) {
    const date = addDays(today, -i)
    const row = byDate.get(date)
    out.push({
      date,
      cost: row ? row.totalCost : 0,
      totalTokens: row ? totalTokensOf(row) : 0,
    })
  }
  return out
}

/** Per-model totals aggregated from the daily modelBreakdowns, sorted by cost
 *  descending (ties by model name for stable output). */
export function modelTable(daily: DailyRow[]): ModelRow[] {
  const byModel = new Map<string, ModelRow>()
  for (const day of daily) {
    for (const b of day.modelBreakdowns) {
      let row = byModel.get(b.modelName)
      if (!row) {
        row = {
          model: b.modelName,
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          cost: 0,
          totalTokens: 0,
          share: 0,
        }
        byModel.set(b.modelName, row)
      }
      row.inputTokens += b.inputTokens
      row.outputTokens += b.outputTokens
      row.cacheCreationTokens += b.cacheCreationTokens
      row.cacheReadTokens += b.cacheReadTokens
      row.cost += b.cost
    }
  }
  const rows = [...byModel.values()]
  let totalCost = 0
  for (const row of rows) {
    row.totalTokens = totalTokensOf(row)
    totalCost += row.cost
  }
  for (const row of rows) row.share = totalCost > 0 ? row.cost / totalCost : 0
  rows.sort((a, b) => b.cost - a.cost || a.model.localeCompare(b.model))
  return rows
}

/** ccusage session ids are dash-joined absolute paths of the project dir
 *  ("-Users-anton-Dev-cate"). Undo that into a readable path-ish name. The
 *  mapping is lossy (dashes inside a directory name are indistinguishable from
 *  separators), which is fine for a display label. */
export function sessionName(sessionId: string): string {
  const cleaned = sessionId.replace(/^-+/, '').replace(/-/g, '/')
  return cleaned || sessionId
}

/** Display name for a session row. Prefers a real projectPath; either source
 *  may be a dash-joined dir, optionally with a "/<session-uuid>" suffix (as in
 *  ccusage's "subagents" rows), which gets decoded and the uuid shortened. */
export function sessionDisplayName(sessionId: string, projectPath: string): string {
  const source =
    projectPath && projectPath !== 'Unknown Project' ? projectPath : sessionId
  if (!source.startsWith('-')) return source
  const slash = source.indexOf('/')
  if (slash === -1) return sessionName(source)
  const dir = sessionName(source.slice(0, slash))
  const rest = source.slice(slash + 1)
  const shortRest = /^[0-9a-f]{8}-[0-9a-f-]+$/i.test(rest) ? rest.slice(0, 8) : rest
  return `${dir} · ${shortRest}`
}

/** Most recent sessions first (lastActivity desc, cost desc as tiebreak). */
export function recentSessions(sessions: SessionRow[], limit: number): SessionSummaryRow[] {
  return [...sessions]
    .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity) || b.totalCost - a.totalCost)
    .slice(0, limit)
    .map((s) => ({
      sessionId: s.sessionId,
      name: sessionDisplayName(s.sessionId, s.projectPath),
      lastActivity: s.lastActivity,
      cost: s.totalCost,
      totalTokens: totalTokensOf(s),
      modelsUsed: s.modelsUsed,
    }))
}

/** Monthly totals, newest month first. */
export function monthlyTable(monthly: MonthlyRow[]): MonthlySummaryRow[] {
  return [...monthly]
    .sort((a, b) => b.month.localeCompare(a.month))
    .map((m) => ({ month: m.month, cost: m.totalCost, totalTokens: totalTokensOf(m) }))
}

// --- the full report -------------------------------------------------------------

export interface RawUsage {
  claudePaths: string[]
  pricingSource: 'online' | 'offline' | 'none'
  daily: DailyRow[]
  sessions: SessionRow[]
  monthly: MonthlyRow[]
}

export interface ReportOptions {
  /** Chart window in calendar days (default 30). Strings (query params) are parsed. */
  days?: number | string
  /** Max session rows (default 15). Strings (query params) are parsed. */
  sessionLimit?: number | string
}

export function buildReport(raw: RawUsage, today: string, opts: ReportOptions = {}): UsageReport {
  const days = clampInt(opts.days, 7, 365, 30)
  const sessionLimit = clampInt(opts.sessionLimit, 1, 100, 15)
  const hasPaths = raw.claudePaths.length > 0
  const hasRows = raw.daily.length > 0 || raw.sessions.length > 0
  const available = hasPaths && hasRows
  return {
    available,
    ...(available ? {} : { reason: hasPaths ? ('no-usage-entries' as const) : ('no-claude-data' as const) }),
    generatedAt: new Date().toISOString(),
    today,
    coverageStart: coverageStartOf(raw.daily, today),
    claudePaths: raw.claudePaths,
    pricingSource: raw.pricingSource,
    summary: summarize(raw.daily, today),
    daily: dailySeries(raw.daily, today, days),
    models: modelTable(raw.daily),
    sessions: recentSessions(raw.sessions, sessionLimit),
    monthly: monthlyTable(raw.monthly),
  }
}

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}
