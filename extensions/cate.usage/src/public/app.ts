// Agent Usage dashboard panel. External script (CSP-safe, no inline JS). It:
//   - themes the chrome from cate.theme.get() via the shared kit
//   - loads the full dashboard payload (GET /api/report?days=N)
//   - renders a single-screen, timeline-first layout that never scrolls: a
//     topline stat strip (today / week / month / all time) with the status
//     pill, and one hero chart card — an inline-SVG daily bar chart
//     (cost or tokens, one series, hover tooltip, selective peak label) that
//     flexes to the panel height, with a per-model chip strip as its footer
//     (cost + share; full token breakdown in the tooltip)
//   - shows REAL load progress: while a load is in flight it polls
//     GET /api/status and renders a determinate bar (loaders done / total)
//     with a label saying what the server is doing
//   - forces a re-read with POST /api/refresh; auto-refreshes every 60s while
//     the panel is visible
//   - persists chart prefs (window, metric) via cate.storage
//
// All fetch URLs are relative so they tunnel through Cate's proxy, which
// injects the bearer; the page never holds a token. Data lands in the DOM via
// textContent only (no innerHTML for values).

import '../_kit/cate-kit.css'
import './style.css'
import { initTheme } from '../_kit/theme'
import { apiFetch } from '../_kit/api-client'
import type { CateHost } from '../_kit/cate-host'
import type { DailyPoint, ModelRow, PeriodSummary, UsageReport } from '../shape'

declare const cate: CateHost | undefined

const REFRESH_INTERVAL_MS = 60_000
const STATUS_POLL_MS = 350
const CHART_WINDOWS = [30, 60, 90] as const
type Metric = 'cost' | 'tokens'

const CHART_ICON =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="M2.5 13.5h11" stroke="currentColor" fill="none" stroke-linecap="round"/><path d="M4.5 13.5v-3M8 13.5V5M11.5 13.5V8" stroke="currentColor" fill="none" stroke-linecap="round"/></svg>'

// --- state ---------------------------------------------------------------------

let report: UsageReport | null = null
let chartDays: number = 30
let metric: Metric = 'cost'
let loading = false
let error: string | null = null

let bodyEl: HTMLElement
let statsEl: HTMLElement
let loadbarEl: HTMLElement
let loadbarFillEl: HTMLElement
let statusEl: HTMLElement

/** First-load center UI, present only while there is no report yet. */
let loadingFillEl: HTMLElement | null = null
let loadingLabelEl: HTMLElement | null = null

// --- tiny DOM helpers ------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild)
}

function svgFrom(markup: string): Node | null {
  const tpl = document.createElement('template')
  tpl.innerHTML = markup.trim() // static, trusted SVG constant
  return tpl.content.firstChild
}

// --- formatting ------------------------------------------------------------------

const usdFine = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
})
const usdCoarse = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

function fmtUsd(v: number): string {
  return v >= 1000 ? usdCoarse.format(v) : usdFine.format(v)
}

function fmtTokens(v: number): string {
  return compact.format(v)
}

function fmtDayLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

// --- storage-backed prefs ----------------------------------------------------------

function host(): CateHost | undefined {
  return typeof cate === 'undefined' ? undefined : cate
}

async function loadPrefs(): Promise<void> {
  try {
    const store = host()?.storage
    if (!store) return
    const days = await store.get('chartDays')
    if (typeof days === 'number' && (CHART_WINDOWS as readonly number[]).includes(days)) {
      chartDays = days
    }
    const m = await store.get('chartMetric')
    if (m === 'cost' || m === 'tokens') metric = m
  } catch {
    /* prefs are cosmetic */
  }
}

function savePref(key: string, value: unknown): void {
  host()
    ?.storage.set(key, value)
    .catch(() => {})
}

// --- load progress -----------------------------------------------------------------

/** Mirror of the server's LoadProgress (usage.ts) + elapsed time, as served by
 *  GET /api/status. */
interface LoadProgress {
  phase: 'scan' | 'pricing' | 'read'
  files: number | null
  offline: boolean | null
  retry: boolean
  readEtaMs: number | null
  phaseElapsedMs: number
}

let statusPollTimer: ReturnType<typeof setInterval> | undefined

function progressLabel(p: LoadProgress): string {
  if (p.phase === 'scan') return 'Scanning usage logs…'
  if (p.phase === 'pricing') return 'Checking live model prices…'
  const files = p.files != null ? `${p.files} usage log${p.files === 1 ? '' : 's'}` : 'usage logs'
  const base = p.retry
    ? `Re-reading ${files} with bundled prices`
    : `Reading ${files}${p.offline ? ' (bundled prices)' : ''}`
  const secs = Math.round(p.phaseElapsedMs / 1000)
  return secs >= 3 ? `${base}… ${secs}s` : `${base}…`
}

/** Bar fraction: fixed slots for the quick phases, then the read phase filling
 *  the rest against its ETA (asymptotic when no previous read is known). */
function progressFraction(p: LoadProgress): number {
  if (p.phase === 'scan') return 0.03
  if (p.phase === 'pricing') return 0.08
  const t = p.phaseElapsedMs
  const inner =
    p.readEtaMs && p.readEtaMs > 0 ? Math.min(1, t / p.readEtaMs) : t / (t + 8000)
  return 0.1 + 0.87 * inner
}

/** Reflect a progress fraction (0..1) in the top bar and the first-load track. */
function setBarFraction(frac: number): void {
  const pct = `${Math.round(Math.min(1, Math.max(0.04, frac)) * 100)}%`
  loadbarFillEl.style.width = pct
  if (loadingFillEl) loadingFillEl.style.width = pct
}

async function pollStatus(): Promise<void> {
  try {
    const res = await apiFetch('api/status', { headers: { accept: 'application/json' } })
    if (!res.ok) return
    const s = (await res.json()) as { loading: boolean; progress: LoadProgress | null }
    if (!loading || !s.loading || !s.progress) return
    setBarFraction(progressFraction(s.progress))
    const label = progressLabel(s.progress)
    if (loadingLabelEl) loadingLabelEl.textContent = label
    progressStatus = label
    syncStatus()
  } catch {
    /* progress is cosmetic; the report fetch carries the real errors */
  }
}

function startStatusPolling(): void {
  stopStatusPolling()
  void pollStatus()
  statusPollTimer = setInterval(() => void pollStatus(), STATUS_POLL_MS)
}

function stopStatusPolling(): void {
  if (statusPollTimer !== undefined) clearInterval(statusPollTimer)
  statusPollTimer = undefined
}

// --- API -------------------------------------------------------------------------

async function fetchReport(force: boolean): Promise<UsageReport> {
  const res = await apiFetch(`api/${force ? 'refresh' : 'report'}?days=${chartDays}`, {
    method: force ? 'POST' : 'GET',
    headers: { accept: 'application/json' },
  })
  const body = (await res.json()) as UsageReport & { error?: string }
  if (!res.ok || body.error) throw new Error(body.error || `Request failed (${res.status})`)
  return body
}

async function load(force: boolean): Promise<void> {
  if (loading) return
  loading = true
  error = null
  loadbarEl.hidden = false
  setBarFraction(0)
  startStatusPolling()
  bodyEl.style.opacity = report ? '0.6' : '1'
  try {
    report = await fetchReport(force)
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  } finally {
    loading = false
    stopStatusPolling()
    loadbarEl.hidden = true
    progressStatus = null
    bodyEl.style.opacity = '1'
    render()
  }
}

// --- topline status pill ------------------------------------------------------------

const PRICING_WARN_TITLE =
  'Live model pricing was unreachable; costs use the bundled table and may miss newer models.'

/** Persistent pill state: true while the report priced with the offline table. */
let pricingWarning = false
/** What the in-flight load is doing right now (null when idle). */
let progressStatus: string | null = null

/** Show the current state in the pill — the in-flight load step, else the
 *  offline-pricing warning, else nothing. */
function syncStatus(): void {
  if (progressStatus !== null && report) {
    statusEl.classList.remove('us-status--warn')
    statusEl.textContent = progressStatus
    statusEl.removeAttribute('title')
    return
  }
  statusEl.classList.toggle('us-status--warn', pricingWarning)
  statusEl.textContent = pricingWarning ? 'offline pricing' : ''
  if (pricingWarning) statusEl.title = PRICING_WARN_TITLE
  else statusEl.removeAttribute('title')
}

// --- chart -----------------------------------------------------------------------

/** "Nice" axis max >= v (1/2/2.5/5 * 10^k), so ticks land on clean numbers. */
function niceMax(v: number): number {
  if (v <= 0) return 1
  const exp = Math.floor(Math.log10(v))
  const base = Math.pow(10, exp)
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (v <= m * base) return m * base
  }
  return 10 * base
}

const SVG_NS = 'http://www.w3.org/2000/svg'

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
  className?: string,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v))
  if (className) node.setAttribute('class', className)
  return node
}

/** Column path: square baseline, rounded top corners (the data end). */
function barPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h)
  const bottom = y + h
  return [
    `M${x} ${bottom}`,
    `V${y + rr}`,
    `Q${x} ${y} ${x + rr} ${y}`,
    `H${x + w - rr}`,
    `Q${x + w} ${y} ${x + w} ${y + rr}`,
    `V${bottom}`,
    'Z',
  ].join('')
}

function renderChart(container: HTMLElement, points: DailyPoint[], which: Metric): void {
  clear(container)
  const width = Math.max(320, container.clientWidth || 640)
  // The chart flexes with the panel; the container's height is the budget.
  const height = Math.max(110, container.clientHeight || 200)
  const pad = { top: 16, right: 8, bottom: 20, left: 46 }
  const innerW = width - pad.left - pad.right
  const innerH = height - pad.top - pad.bottom

  const value = (p: DailyPoint) => (which === 'cost' ? p.cost : p.totalTokens)
  const fmt = which === 'cost' ? fmtUsd : fmtTokens
  const rawMax = Math.max(0, ...points.map(value))
  const max = niceMax(rawMax)

  const svg = svgEl('svg', {
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-label': which === 'cost' ? 'Daily cost' : 'Daily tokens',
  })

  const yOf = (v: number) => pad.top + innerH * (1 - v / max)

  // Hairline gridlines + clean y ticks (0, half, max).
  for (const frac of [0, 0.5, 1]) {
    const v = max * frac
    const y = yOf(v)
    svg.appendChild(svgEl('line', { x1: pad.left, x2: width - pad.right, y1: y, y2: y }, 'us-grid'))
    const tick = svgEl('text', { x: pad.left - 6, y: y + 3, 'text-anchor': 'end' }, 'us-tick')
    tick.textContent = which === 'cost' ? fmtUsd(v) : fmtTokens(v)
    svg.appendChild(tick)
  }

  // X tick labels: first, last, and every ~week in between.
  const n = points.length
  const slot = innerW / n
  const step = n > 45 ? 14 : 7
  for (let i = 0; i < n; i++) {
    if (i !== 0 && i !== n - 1 && i % step !== 0) continue
    if (i !== n - 1 && n - 1 - i < step / 2 && i !== 0) continue // avoid colliding with the last label
    const x = pad.left + slot * i + slot / 2
    const anchor = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'
    const tick = svgEl(
      'text',
      { x: i === 0 ? pad.left : i === n - 1 ? width - pad.right : x, y: height - 6, 'text-anchor': anchor },
      'us-tick',
    )
    tick.textContent = fmtDayLabel(points[i].date)
    svg.appendChild(tick)
  }

  // Tooltip host (positioned within the chart container).
  const tip = el('div', 'us-tip')
  tip.hidden = true
  const tipValue = el('div', 'us-tip__value')
  const tipDate = el('div')
  const tipOther = el('div')
  tip.append(tipValue, tipDate, tipOther)

  // Bars: <=24px thick with a 2px surface gap, rounded data-end, square base.
  const gap = 2
  const barW = Math.min(24, Math.max(1, slot - gap))
  let peakIndex = -1
  let peakValue = -1
  for (let i = 0; i < n; i++) {
    const v = value(points[i])
    if (v > peakValue) {
      peakValue = v
      peakIndex = i
    }
  }

  for (let i = 0; i < n; i++) {
    const p = points[i]
    const v = value(p)
    const x = pad.left + slot * i + (slot - barW) / 2
    const h = max > 0 ? (v / max) * innerH : 0
    const y = pad.top + innerH - h
    const bar = svgEl('path', { d: barPath(x, y, barW, Math.max(h, v > 0 ? 1 : 0), 4) }, 'us-bar')

    // Hit target: the full slot band, larger than the mark.
    const hit = svgEl(
      'rect',
      { x: pad.left + slot * i, y: pad.top, width: slot, height: innerH },
      'us-bar-hit',
    )
    const show = (ev: PointerEvent) => {
      bar.classList.add('is-hover')
      tipValue.textContent = fmt(v)
      tipDate.textContent = fmtDayLabel(p.date)
      tipOther.textContent =
        which === 'cost' ? `${fmtTokens(p.totalTokens)} tokens` : fmtUsd(p.cost)
      tip.hidden = false
      const rect = container.getBoundingClientRect()
      const tx = Math.min(ev.clientX - rect.left + 12, rect.width - tip.offsetWidth - 4)
      const ty = Math.max(ev.clientY - rect.top - tip.offsetHeight - 10, 0)
      tip.style.left = `${Math.max(0, tx)}px`
      tip.style.top = `${ty}px`
    }
    hit.addEventListener('pointermove', show)
    hit.addEventListener('pointerleave', () => {
      bar.classList.remove('is-hover')
      tip.hidden = true
    })
    svg.appendChild(bar)
    svg.appendChild(hit)
  }

  // Selective direct label: the peak only.
  if (peakIndex >= 0 && peakValue > 0) {
    const cx = pad.left + slot * peakIndex + slot / 2
    const label = svgEl(
      'text',
      {
        x: Math.min(Math.max(cx, pad.left + 20), width - pad.right - 20),
        y: yOf(peakValue) - 5,
        'text-anchor': 'middle',
      },
      'us-peak',
    )
    label.textContent = fmt(peakValue)
    svg.appendChild(label)
  }

  container.appendChild(svg)
  container.appendChild(tip)
}

// --- sections ---------------------------------------------------------------------

function stat(label: string, period: PeriodSummary): HTMLElement {
  const wrap = el('div', 'us-stat')
  wrap.appendChild(el('span', 'us-stat__label', label))
  const row = el('div', 'us-stat__row')
  row.appendChild(el('span', 'us-stat__value', fmtUsd(period.cost)))
  row.appendChild(el('span', 'us-stat__sub', `${fmtTokens(period.totalTokens)} tok`))
  wrap.appendChild(row)
  return wrap
}

function segmented<T extends string | number>(
  options: readonly T[],
  active: T,
  label: (o: T) => string,
  onPick: (o: T) => void,
): HTMLElement {
  const wrap = el('div', 'us-seg')
  wrap.setAttribute('role', 'group')
  for (const opt of options) {
    const btn = el('button', undefined, label(opt))
    btn.type = 'button'
    btn.setAttribute('aria-pressed', String(opt === active))
    btn.addEventListener('click', () => onPick(opt))
    wrap.appendChild(btn)
  }
  return wrap
}

/** Per-model chip strip, the chart card's footer: name + cost + cost share,
 *  with the full token breakdown in the tooltip. */
function modelStrip(models: ModelRow[]): HTMLElement {
  const foot = el('div', 'us-card__foot')
  foot.appendChild(el('span', 'us-foot__label', 'By model'))
  for (const m of models) {
    const chip = el('span', 'us-modelchip')
    chip.title =
      `in ${fmtTokens(m.inputTokens)} · out ${fmtTokens(m.outputTokens)} · ` +
      `cache r ${fmtTokens(m.cacheReadTokens)} / w ${fmtTokens(m.cacheCreationTokens)} · ` +
      `${(m.share * 100).toFixed(1)}% of total cost`
    chip.appendChild(el('b', undefined, m.model))
    chip.appendChild(el('span', undefined, fmtUsd(m.cost)))
    chip.appendChild(el('i', undefined, `${(m.share * 100).toFixed(m.share >= 0.1 ? 0 : 1)}%`))
    foot.appendChild(chip)
  }
  return foot
}

function renderEmpty(r: UsageReport): HTMLElement {
  const wrap = el('div', 'us-center')
  const empty = el('div', 'cate-empty')
  const icon = el('div', 'cate-empty__icon')
  const svg = svgFrom(CHART_ICON)
  if (svg) icon.appendChild(svg)
  empty.appendChild(icon)
  empty.appendChild(el('h2', undefined, 'No agent usage found'))
  empty.appendChild(
    el(
      'p',
      undefined,
      'This dashboard reads Claude Code usage logs from the machine where this ' +
        "extension's server runs (for a remote workspace, that is the remote host).",
    ),
  )
  if (r.reason === 'no-claude-data') {
    empty.appendChild(
      el(
        'p',
        undefined,
        'No Claude data directory was found there. Once Claude Code has run on that ' +
          'machine, usage appears here automatically. A custom data location can be ' +
          'pointed at with the CLAUDE_CONFIG_DIR environment variable.',
      ),
    )
  } else {
    empty.appendChild(
      el(
        'p',
        undefined,
        'A Claude data directory exists but contains no usage entries yet. Run a ' +
          'Claude Code session and refresh.',
      ),
    )
    if (r.claudePaths.length) {
      const paths = el('p', 'us-empty-paths')
      paths.appendChild(el('span', undefined, 'Checked: '))
      paths.appendChild(el('code', undefined, r.claudePaths.join(', ')))
      empty.appendChild(paths)
    }
  }
  const retry = el('button', 'cate-btn cate-btn--primary', 'Check again')
  retry.type = 'button'
  retry.addEventListener('click', () => void load(true))
  empty.appendChild(retry)
  wrap.appendChild(empty)
  return wrap
}

// --- top-level render --------------------------------------------------------------

function render(): void {
  clear(bodyEl)
  clear(statsEl)
  loadingFillEl = null
  loadingLabelEl = null

  if (error) {
    const banner = el('div', 'cate-banner cate-banner--error')
    banner.appendChild(el('span', undefined, `Failed to load usage: ${error} `))
    const retry = el('button', 'cate-btn cate-btn--small', 'Retry')
    retry.type = 'button'
    retry.addEventListener('click', () => void load(false))
    banner.appendChild(retry)
    bodyEl.appendChild(banner)
    if (!report) return
  }

  if (!report) {
    const center = el('div', 'us-center')
    const box = el('div', 'us-loading')
    const track = el('div', 'us-track')
    loadingFillEl = el('i')
    track.appendChild(loadingFillEl)
    box.appendChild(track)
    loadingLabelEl = el('span', undefined, 'Contacting extension server…')
    box.appendChild(loadingLabelEl)
    center.appendChild(box)
    bodyEl.appendChild(center)
    return
  }

  pricingWarning = report.available && report.pricingSource === 'offline'
  syncStatus()

  if (!report.available) {
    bodyEl.appendChild(renderEmpty(report))
    return
  }

  // Topline stat strip.
  statsEl.appendChild(stat('Today', report.summary.today))
  statsEl.appendChild(stat('Week', report.summary.thisWeek))
  statsEl.appendChild(stat('Month', report.summary.thisMonth))
  statsEl.appendChild(stat('All time', report.summary.allTime))

  // Hero timeline card: metric + window toggles, flexing chart, model footer.
  const metricSeg = segmented<Metric>(['cost', 'tokens'], metric, (m) => (m === 'cost' ? 'Cost' : 'Tokens'), (m) => {
    metric = m
    savePref('chartMetric', m)
    render()
  })
  const windowSeg = segmented<number>([...CHART_WINDOWS], chartDays, (d) => `${d}d`, (d) => {
    chartDays = d
    savePref('chartDays', d)
    void load(false)
  })

  const chartCard = el('section', 'cate-card us-card us-chartcard')
  const head = el('div', 'us-card__head')
  head.appendChild(el('div', 'us-card__title', metric === 'cost' ? 'Daily cost' : 'Daily tokens'))
  head.appendChild(el('div', 'us-card__spacer'))
  head.appendChild(metricSeg)
  head.appendChild(windowSeg)
  chartCard.appendChild(head)
  const chartBody = el('div', 'us-card__body us-chart')
  chartCard.appendChild(chartBody)
  if (report.models.length) chartCard.appendChild(modelStrip(report.models))
  bodyEl.appendChild(chartCard)

  // Draw after the card is in the layout so the flexed height is final.
  renderChart(chartBody, report.daily, metric)
}

// --- mount -------------------------------------------------------------------------

function mount(): void {
  const root = document.getElementById('root')
  if (!root) return
  const app = el('div', 'cate-app')

  loadbarEl = el('div', 'us-loadbar')
  loadbarEl.hidden = true
  loadbarFillEl = el('i')
  loadbarEl.appendChild(loadbarFillEl)
  app.appendChild(loadbarEl)

  // Topline: stat strip on the left, status pill on the right. Content, not
  // chrome — it doubles as the header row.
  const topline = el('div', 'us-topline')
  statsEl = el('div', 'us-stats')
  topline.appendChild(statsEl)

  statusEl = el('span', 'us-status')
  statusEl.setAttribute('role', 'status')
  topline.appendChild(statusEl)
  app.appendChild(topline)

  bodyEl = el('div', 'us-body')
  app.appendChild(bodyEl)
  root.appendChild(app)

  render()
}

let redrawQueued = false
window.addEventListener('resize', () => {
  if (redrawQueued) return
  redrawQueued = true
  requestAnimationFrame(() => {
    redrawQueued = false
    if (report?.available) render()
  })
})

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void load(false)
})

setInterval(() => {
  if (document.visibilityState === 'visible') void load(false)
}, REFRESH_INTERVAL_MS)

void (async () => {
  await initTheme()
  await loadPrefs()
  mount()
  await load(false)
})()
