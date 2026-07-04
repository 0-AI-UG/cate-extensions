// Report-shaping tests against fixture ccusage JSON. The fixtures mirror the
// row shapes ccusage@18's data-loader returns (verified against real output of
// loadDailyUsageData / loadSessionData / loadMonthlyUsageData).

import { describe, expect, it } from 'vitest'
import {
  addDays,
  buildReport,
  clampInt,
  dailySeries,
  modelTable,
  monthlyTable,
  recentSessions,
  sessionDisplayName,
  sessionName,
  startOfMonth,
  startOfWeek,
  summarize,
  totalTokensOf,
  type DailyRow,
  type MonthlyRow,
  type SessionRow,
} from './shape'

// --- fixtures (ccusage@18 shapes) -------------------------------------------------

function day(date: string, overrides: Partial<DailyRow> = {}): DailyRow {
  return {
    date,
    inputTokens: 1000,
    outputTokens: 2000,
    cacheCreationTokens: 3000,
    cacheReadTokens: 4000,
    totalCost: 10,
    modelsUsed: ['claude-opus-4-8'],
    modelBreakdowns: [
      {
        modelName: 'claude-opus-4-8',
        inputTokens: 1000,
        outputTokens: 2000,
        cacheCreationTokens: 3000,
        cacheReadTokens: 4000,
        cost: 10,
      },
    ],
    ...overrides,
  }
}

// A realistic multi-model day, matching real ccusage output observed on this
// machine (two models, per-model breakdowns summing to the day totals).
const MULTI_MODEL_DAY: DailyRow = {
  date: '2026-06-03',
  inputTokens: 13814,
  outputTokens: 215905,
  cacheCreationTokens: 650347,
  cacheReadTokens: 32128834,
  totalCost: 23.45220515,
  modelsUsed: ['claude-opus-4-8', 'claude-haiku-4-5-20251001'],
  modelBreakdowns: [
    {
      modelName: 'claude-opus-4-8',
      inputTokens: 13517,
      outputTokens: 202003,
      cacheCreationTokens: 467091,
      cacheReadTokens: 29758665,
      cost: 22.91631125,
    },
    {
      modelName: 'claude-haiku-4-5-20251001',
      inputTokens: 297,
      outputTokens: 13902,
      cacheCreationTokens: 183256,
      cacheReadTokens: 2370169,
      cost: 0.5358939,
    },
  ],
}

function session(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    sessionId: '-Users-anton-Dev-cate',
    projectPath: 'Unknown Project',
    inputTokens: 100,
    outputTokens: 200,
    cacheCreationTokens: 300,
    cacheReadTokens: 400,
    totalCost: 5,
    lastActivity: '2026-07-01',
    modelsUsed: ['claude-opus-4-8'],
    ...overrides,
  }
}

function month(m: string, cost: number): MonthlyRow {
  return {
    month: m,
    inputTokens: 10,
    outputTokens: 20,
    cacheCreationTokens: 30,
    cacheReadTokens: 40,
    totalCost: cost,
  }
}

// --- date helpers -----------------------------------------------------------------

describe('date helpers', () => {
  it('addDays crosses month and year boundaries', () => {
    expect(addDays('2026-07-01', -1)).toBe('2026-06-30')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01')
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29') // leap year
  })

  it('startOfWeek returns the Monday of the ISO week', () => {
    expect(startOfWeek('2026-07-04')).toBe('2026-06-29') // Saturday -> Monday
    expect(startOfWeek('2026-06-29')).toBe('2026-06-29') // Monday is itself
    expect(startOfWeek('2026-07-05')).toBe('2026-06-29') // Sunday belongs to the past week
    expect(startOfWeek('2026-07-06')).toBe('2026-07-06') // next Monday starts a new week
  })

  it('startOfMonth', () => {
    expect(startOfMonth('2026-07-04')).toBe('2026-07-01')
    expect(startOfMonth('2026-12-31')).toBe('2026-12-01')
  })
})

// --- summarize ---------------------------------------------------------------------

describe('summarize', () => {
  // Today is Saturday 2026-07-04; the ISO week began Monday 2026-06-29.
  const today = '2026-07-04'
  const daily = [
    day('2026-06-27', { totalCost: 100 }), // previous week, previous month
    day('2026-06-30', { totalCost: 40 }), // this week, previous month
    day('2026-07-01', { totalCost: 7 }), // this week, this month
    day('2026-07-04', { totalCost: 3 }), // today
  ]

  it('buckets cost into today / week / month / all time', () => {
    const s = summarize(daily, today)
    expect(s.today.cost).toBe(3)
    expect(s.thisWeek.cost).toBe(50) // 40 + 7 + 3
    expect(s.thisMonth.cost).toBe(10) // 7 + 3
    expect(s.allTime.cost).toBe(150)
    expect(s.allTime.days).toBe(4)
  })

  it('sums token totals across all four buckets', () => {
    const s = summarize(daily, today)
    expect(s.today.totalTokens).toBe(10_000)
    expect(s.allTime.totalTokens).toBe(40_000)
    expect(s.allTime.inputTokens).toBe(4000)
    expect(s.allTime.outputTokens).toBe(8000)
  })

  it('ignores rows dated after today and handles empty input', () => {
    const s = summarize([day('2026-07-05', { totalCost: 99 })], today)
    expect(s.allTime.cost).toBe(0)
    const empty = summarize([], today)
    expect(empty.today.cost).toBe(0)
    expect(empty.allTime.days).toBe(0)
  })
})

// --- dailySeries --------------------------------------------------------------------

describe('dailySeries', () => {
  it('zero-fills the window and clips rows outside it', () => {
    const series = dailySeries(
      [day('2026-07-01', { totalCost: 7 }), day('2026-06-01', { totalCost: 999 })],
      '2026-07-04',
      7,
    )
    expect(series).toHaveLength(7)
    expect(series[0].date).toBe('2026-06-28')
    expect(series[6].date).toBe('2026-07-04')
    expect(series.map((p) => p.cost)).toEqual([0, 0, 0, 7, 0, 0, 0])
    expect(series[3].totalTokens).toBe(10_000)
  })

  it('is ascending and ends at today', () => {
    const series = dailySeries([], '2026-01-03', 5)
    expect(series.map((p) => p.date)).toEqual([
      '2025-12-30',
      '2025-12-31',
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
    ])
  })
})

// --- modelTable ----------------------------------------------------------------------

describe('modelTable', () => {
  it('aggregates model breakdowns across days, sorted by cost desc', () => {
    const rows = modelTable([
      MULTI_MODEL_DAY,
      day('2026-06-04', {
        modelBreakdowns: [
          {
            modelName: 'claude-haiku-4-5-20251001',
            inputTokens: 100,
            outputTokens: 200,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            cost: 0.5,
          },
        ],
      }),
    ])
    expect(rows.map((r) => r.model)).toEqual(['claude-opus-4-8', 'claude-haiku-4-5-20251001'])
    const haiku = rows[1]
    expect(haiku.inputTokens).toBe(297 + 100)
    expect(haiku.cost).toBeCloseTo(1.0358939, 6)
    expect(haiku.totalTokens).toBe(297 + 100 + 13902 + 200 + 183256 + 2370169)
  })

  it('computes cost shares that sum to 1', () => {
    const rows = modelTable([MULTI_MODEL_DAY])
    const total = rows.reduce((acc, r) => acc + r.share, 0)
    expect(total).toBeCloseTo(1, 9)
    expect(rows[0].share).toBeGreaterThan(0.9)
  })

  it('handles zero-cost data without dividing by zero', () => {
    const rows = modelTable([
      day('2026-06-04', {
        modelBreakdowns: [
          {
            modelName: 'free-model',
            inputTokens: 1,
            outputTokens: 1,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            cost: 0,
          },
        ],
      }),
    ])
    expect(rows[0].share).toBe(0)
  })

  it('returns [] for no data', () => {
    expect(modelTable([])).toEqual([])
  })
})

// --- sessions -------------------------------------------------------------------------

describe('recentSessions', () => {
  it('sorts by lastActivity desc with cost as tiebreak, limited', () => {
    const rows = recentSessions(
      [
        session({ sessionId: 'a', lastActivity: '2026-07-01', totalCost: 1 }),
        session({ sessionId: 'b', lastActivity: '2026-07-03', totalCost: 2 }),
        session({ sessionId: 'c', lastActivity: '2026-07-03', totalCost: 9 }),
        session({ sessionId: 'd', lastActivity: '2026-06-01', totalCost: 50 }),
      ],
      3,
    )
    expect(rows.map((r) => r.sessionId)).toEqual(['c', 'b', 'a'])
  })

  it('derives a readable name from the dash-joined session id', () => {
    const [row] = recentSessions([session()], 5)
    expect(row.name).toBe('Users/anton/Dev/cate')
    expect(row.totalTokens).toBe(1000)
  })

  it('prefers a real projectPath over the derived name', () => {
    const [row] = recentSessions([session({ projectPath: 'my-project' })], 5)
    expect(row.name).toBe('my-project')
  })
})

describe('sessionName', () => {
  it('strips the leading dash and joins with slashes', () => {
    expect(sessionName('-Users-anton-Dev-cate')).toBe('Users/anton/Dev/cate')
    expect(sessionName('plain')).toBe('plain')
  })
})

describe('sessionDisplayName', () => {
  it('decodes a dashed projectPath with a session uuid suffix (subagents rows)', () => {
    expect(
      sessionDisplayName('subagents', '-Users-anton-Dev-cate/82403073-c058-404e-88b2-7c78e723a7f3'),
    ).toBe('Users/anton/Dev/cate · 82403073')
  })

  it('falls back to the decoded sessionId when projectPath is unknown', () => {
    expect(sessionDisplayName('-Users-anton-Dev-cate', 'Unknown Project')).toBe(
      'Users/anton/Dev/cate',
    )
  })

  it('passes plain names through untouched', () => {
    expect(sessionDisplayName('id', 'my-project')).toBe('my-project')
    expect(sessionDisplayName('subagents', 'Unknown Project')).toBe('subagents')
  })
})

// --- monthly --------------------------------------------------------------------------

describe('monthlyTable', () => {
  it('sorts newest month first and totals tokens', () => {
    const rows = monthlyTable([month('2026-05', 10), month('2026-07', 30), month('2026-06', 20)])
    expect(rows.map((r) => r.month)).toEqual(['2026-07', '2026-06', '2026-05'])
    expect(rows[0].cost).toBe(30)
    expect(rows[0].totalTokens).toBe(100)
  })
})

// --- buildReport ----------------------------------------------------------------------

describe('buildReport', () => {
  const raw = {
    claudePaths: ['/home/user/.claude'],
    pricingSource: 'online' as const,
    daily: [MULTI_MODEL_DAY, day('2026-07-01', { totalCost: 7 })],
    sessions: [session()],
    monthly: [month('2026-06', 23.45), month('2026-07', 7)],
  }

  it('assembles the full payload', () => {
    const report = buildReport(raw, '2026-07-04', { days: 30 })
    expect(report.available).toBe(true)
    expect(report.reason).toBeUndefined()
    expect(report.daily).toHaveLength(30)
    expect(report.daily[report.daily.length - 1].date).toBe('2026-07-04')
    expect(report.summary.thisMonth.cost).toBe(7)
    expect(report.models[0].model).toBe('claude-opus-4-8')
    expect(report.sessions).toHaveLength(1)
    expect(report.monthly[0].month).toBe('2026-07')
    expect(report.pricingSource).toBe('online')
  })

  it('flags the no-claude-data empty state', () => {
    const report = buildReport(
      { claudePaths: [], pricingSource: 'none', daily: [], sessions: [], monthly: [] },
      '2026-07-04',
    )
    expect(report.available).toBe(false)
    expect(report.reason).toBe('no-claude-data')
    expect(report.daily).toHaveLength(30) // zero-filled, chart-safe
    expect(report.summary.allTime.cost).toBe(0)
  })

  it('flags the no-usage-entries empty state when a data dir exists but is empty', () => {
    const report = buildReport(
      {
        claudePaths: ['/home/user/.claude'],
        pricingSource: 'offline',
        daily: [],
        sessions: [],
        monthly: [],
      },
      '2026-07-04',
    )
    expect(report.available).toBe(false)
    expect(report.reason).toBe('no-usage-entries')
  })

  it('clamps the requested window and session limit', () => {
    const report = buildReport(raw, '2026-07-04', { days: 100000, sessionLimit: -3 })
    expect(report.daily).toHaveLength(365)
    expect(report.sessions).toHaveLength(1)
  })
})

// --- misc helpers ----------------------------------------------------------------------

describe('helpers', () => {
  it('totalTokensOf sums all four token kinds', () => {
    expect(
      totalTokensOf({
        inputTokens: 1,
        outputTokens: 2,
        cacheCreationTokens: 3,
        cacheReadTokens: 4,
      }),
    ).toBe(10)
  })

  it('clampInt parses strings, clamps, and falls back', () => {
    expect(clampInt('45', 7, 365, 30)).toBe(45)
    expect(clampInt('9999', 7, 365, 30)).toBe(365)
    expect(clampInt('1', 7, 365, 30)).toBe(7)
    expect(clampInt('abc', 7, 365, 30)).toBe(30)
    expect(clampInt(undefined, 7, 365, 30)).toBe(30)
  })
})
