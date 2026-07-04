// =============================================================================
// Mermaid diagram editor, mounted as a Cate extension panel.
//
// Split pane: plain-text source editor (textarea) on the left, live-rendered
// diagram on the right via the bundled `mermaid` package, with a draggable
// divider between them. Glue around it:
//   - cate.theme  : kit token bridge for the chrome + the 'auto' diagram theme.
//   - cate.storage: autosave source, diagram theme, and split ratio
//     per-panel; restore them on reload.
//
// Everything is vendored into dist/ (mermaid's lazy diagram grammars become
// local chunks), so the panel works under Cate's strict extension CSP: no CDN,
// no external fetch, no inline scripts.
// =============================================================================

import mermaid from 'mermaid'
import './_kit/cate-kit.css'
import './styles.css'
import { createAutosaver } from './autosave'
import { applyTheme } from './_kit/theme'
import {
  DEFAULT_OPTIONS,
  DEFAULT_SOURCE,
  DEFAULT_SPLIT,
  clampSplit,
  renderErrorMessage,
  resolveMermaidTheme,
  sanitizeStoredOptions,
  sanitizeStoredSource,
  sanitizeStoredSplit,
  type RenderOptions,
  type ThemeChoice,
} from './state'

const SOURCE_KEY = 'source'
const OPTIONS_KEY = 'options'
const SPLIT_KEY = 'split'
const SAVE_DEBOUNCE_MS = 700
const RENDER_DEBOUNCE_MS = 250
const PNG_SCALE = 2

/** Cate injects `window.cate`; outside Cate (a plain browser) it's undefined
 *  and the editor still works, just without theme/persistence. */
const host = window.cate

// --- static shell (no inline scripts; CSP-safe) ------------------------------

document.getElementById('root')!.innerHTML = `
  <div class="cate-app mmd-app">
    <div class="mmd-overlay">
      <span id="mmd-status" class="mmd-status" role="status"></span>
      <button id="mmd-more" class="cate-iconbtn" type="button" aria-haspopup="menu" aria-expanded="false" aria-label="Diagram options" title="Diagram options">&#x22ef;</button>
      <div id="mmd-popover" class="mmd-popover" hidden>
        <label class="mmd-popover__row">
          <span class="mmd-popover__label">Theme</span>
          <select id="mmd-theme" class="cate-select mmd-select" aria-label="Diagram theme">
            <option value="auto">auto</option>
            <option value="default">light</option>
            <option value="dark">dark</option>
            <option value="forest">forest</option>
            <option value="neutral">neutral</option>
          </select>
        </label>
        <div class="mmd-popover__row">
          <span class="mmd-popover__label">Download</span>
          <button id="mmd-dl-svg" class="cate-btn cate-btn--small" type="button" disabled>SVG</button>
          <button id="mmd-dl-png" class="cate-btn cate-btn--small" type="button" disabled>PNG</button>
        </div>
      </div>
    </div>
    <div id="mmd-split" class="mmd-split">
      <textarea
        id="mmd-source"
        class="mmd-source"
        spellcheck="false"
        autocomplete="off"
        autocapitalize="off"
        aria-label="Mermaid source"
        placeholder="Type a Mermaid diagram, e.g. flowchart TD ..."
      ></textarea>
      <div
        id="mmd-divider"
        class="mmd-divider"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize editor"
        title="Drag to resize, double-click to reset"
      ></div>
      <div class="mmd-right">
        <div id="mmd-preview" class="mmd-preview" aria-label="Diagram preview"></div>
        <div id="mmd-error" class="cate-banner cate-banner--error mmd-error" hidden></div>
      </div>
    </div>
  </div>
`

const sourceEl = document.getElementById('mmd-source') as HTMLTextAreaElement
const splitEl = document.getElementById('mmd-split')!
const dividerEl = document.getElementById('mmd-divider')!
const previewEl = document.getElementById('mmd-preview')!
const errorEl = document.getElementById('mmd-error')!
const statusEl = document.getElementById('mmd-status')!
const themeSel = document.getElementById('mmd-theme') as HTMLSelectElement
const moreBtn = document.getElementById('mmd-more') as HTMLButtonElement
const popoverEl = document.getElementById('mmd-popover')!
const dlSvgBtn = document.getElementById('mmd-dl-svg') as HTMLButtonElement
const dlPngBtn = document.getElementById('mmd-dl-png') as HTMLButtonElement

// --- rendering ----------------------------------------------------------------

/** The SVG markup of the last successful render (what export acts on). */
let currentSvg = ''
/** Monotonic render token: only the latest async render may touch the DOM. */
let renderSeq = 0
/** Host theme snapshot from boot; 'auto' resolves against it. */
let hostTheme: unknown
/** Active render options (theme), persisted per panel. */
let options: RenderOptions = { ...DEFAULT_OPTIONS }

/** (Re)configure mermaid for the active options. Mermaid reads its config at
 *  render time, so calling initialize again is enough — the next
 *  renderDiagram() picks it up. `htmlLabels: false` is the PNG-export mode:
 *  labels become plain SVG text instead of <foreignObject> HTML, which would
 *  taint the rasterization canvas. */
function initMermaid(opts: { htmlLabels?: boolean } = {}): void {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: resolveMermaidTheme(options.theme, hostTheme),
    htmlLabels: opts.htmlLabels,
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif",
  })
}

function showError(message: string | null): void {
  if (message === null) {
    errorEl.hidden = true
    errorEl.textContent = ''
  } else {
    errorEl.hidden = false
    errorEl.textContent = message
  }
}

async function renderDiagram(source: string): Promise<void> {
  const seq = ++renderSeq
  const text = source.trim()
  if (!text) {
    currentSvg = ''
    previewEl.innerHTML = ''
    previewEl.classList.add('mmd-preview--empty')
    previewEl.textContent = 'Nothing to render yet.'
    showError(null)
    updateExportButtons()
    return
  }
  try {
    // Validate first: parse() rejects with the grammar error message, and
    // skipping render() on bad input avoids mermaid's error artefacts.
    await mermaid.parse(text)
    const { svg } = await mermaid.render(`mmd-render-${seq}`, text)
    if (seq !== renderSeq) return // a newer edit superseded this render
    currentSvg = svg
    previewEl.classList.remove('mmd-preview--empty')
    previewEl.innerHTML = svg
    showError(null)
  } catch (err) {
    if (seq !== renderSeq) return
    // Keep the last good diagram on screen; surface the error underneath so
    // the panel is never blank while the user is mid-edit.
    showError(renderErrorMessage(err))
    // mermaid.render can leave a temp element behind on failure; drop it.
    document.getElementById(`dmmd-render-${seq}`)?.remove()
  }
  updateExportButtons()
}

const renderer = createAutosaver((src) => void renderDiagram(src), RENDER_DEBOUNCE_MS)

// --- autosave -------------------------------------------------------------------

const saver = createAutosaver((src) => {
  // A rejected write (host gone, storage error) must not become an unhandled
  // rejection; losing one autosave is acceptable.
  host?.storage.panel.set(SOURCE_KEY, src).catch(() => {})
}, SAVE_DEBOUNCE_MS)

const flush = () => saver.flush()
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flush()
})
window.addEventListener('pagehide', flush)

// --- export ---------------------------------------------------------------------

let statusTimer: ReturnType<typeof setTimeout> | undefined
function setStatus(message: string): void {
  statusEl.textContent = message
  clearTimeout(statusTimer)
  statusTimer = setTimeout(() => {
    statusEl.textContent = ''
  }, 2000)
}

function updateExportButtons(): void {
  const enabled = currentSvg.length > 0
  dlSvgBtn.disabled = !enabled
  dlPngBtn.disabled = !enabled
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  // Give the download a tick to start before revoking the blob URL.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

let exportSeq = 0

/** Re-render the current source for rasterization. The on-screen render uses
 *  <foreignObject> HTML labels, and Chromium taints any canvas that draws an
 *  SVG image containing one — so the export render swaps to SVG-only labels.
 *  Uses its own id counter so it never cancels an in-flight preview render. */
async function renderExportSvg(): Promise<string> {
  const id = `mmd-export-${++exportSeq}`
  initMermaid({ htmlLabels: false })
  try {
    const { svg } = await mermaid.render(id, sourceEl.value.trim())
    return svg
  } catch (err) {
    document.getElementById(`d${id}`)?.remove()
    throw err
  } finally {
    initMermaid()
  }
}

/** Rasterize SVG markup. Dimensions come from its viewBox (mermaid sizes via
 *  viewBox; the width attribute is often just "100%"). */
async function svgToPngBlob(exportMarkup: string): Promise<Blob> {
  const holder = document.createElement('div')
  holder.innerHTML = exportMarkup
  const svgEl = holder.querySelector('svg')
  if (!svgEl) throw new Error('no rendered diagram')
  const box = svgEl.viewBox.baseVal
  const liveSvg = previewEl.querySelector('svg')
  const width = Math.ceil(box?.width || liveSvg?.clientWidth || 0)
  const height = Math.ceil(box?.height || liveSvg?.clientHeight || 0)
  if (!width || !height) throw new Error('diagram has no size')

  // Explicit pixel dimensions so <img> decodes at full size instead of the
  // 300x150 SVG default.
  svgEl.setAttribute('width', String(width))
  svgEl.setAttribute('height', String(height))
  const markup = new XMLSerializer().serializeToString(svgEl)
  const svgUrl = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }))
  try {
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('SVG rasterization failed'))
      img.src = svgUrl
    })
    const canvas = document.createElement('canvas')
    canvas.width = width * PNG_SCALE
    canvas.height = height * PNG_SCALE
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas unavailable')
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG encoding failed'))), 'image/png')
    })
  } finally {
    URL.revokeObjectURL(svgUrl)
  }
}

dlSvgBtn.addEventListener('click', () => {
  if (!currentSvg) return
  setPopoverOpen(false)
  downloadBlob(new Blob([currentSvg], { type: 'image/svg+xml' }), 'diagram.svg')
  setStatus('SVG downloaded')
})

dlPngBtn.addEventListener('click', () => {
  if (!currentSvg) return
  setPopoverOpen(false)
  renderExportSvg()
    .then(svgToPngBlob)
    .then((blob) => {
      downloadBlob(blob, 'diagram.png')
      setStatus('PNG downloaded')
    })
    .catch(() => setStatus('PNG export failed'))
})

// --- options popover ---------------------------------------------------------------

function setPopoverOpen(open: boolean): void {
  popoverEl.hidden = !open
  moreBtn.setAttribute('aria-expanded', String(open))
}

moreBtn.addEventListener('click', () => setPopoverOpen(popoverEl.hidden))

document.addEventListener('pointerdown', (e) => {
  if (popoverEl.hidden) return
  if (e.target instanceof Node && moreBtn.parentElement!.contains(e.target)) return
  setPopoverOpen(false)
})

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') setPopoverOpen(false)
})

// --- render options ---------------------------------------------------------------

function saveOptions(): void {
  host?.storage.panel.set(OPTIONS_KEY, options).catch(() => {})
}

function onOptionsChanged(): void {
  saveOptions()
  initMermaid()
  void renderDiagram(sourceEl.value)
}

themeSel.addEventListener('change', () => {
  options = { ...options, theme: themeSel.value as ThemeChoice }
  onOptionsChanged()
})

// --- split drag -------------------------------------------------------------------

function applySplit(ratio: number): void {
  sourceEl.style.flexBasis = `${(ratio * 100).toFixed(2)}%`
}

function saveSplit(ratio: number): void {
  host?.storage.panel.set(SPLIT_KEY, ratio).catch(() => {})
}

let splitRatio = DEFAULT_SPLIT

dividerEl.addEventListener('pointerdown', (down) => {
  if (down.button !== 0) return
  down.preventDefault()
  dividerEl.setPointerCapture(down.pointerId)
  splitEl.classList.add('mmd-split--dragging')

  const onMove = (move: PointerEvent) => {
    const rect = splitEl.getBoundingClientRect()
    if (rect.width <= 0) return
    splitRatio = clampSplit((move.clientX - rect.left) / rect.width)
    applySplit(splitRatio)
  }
  const onUp = () => {
    dividerEl.removeEventListener('pointermove', onMove)
    dividerEl.removeEventListener('pointerup', onUp)
    dividerEl.removeEventListener('pointercancel', onUp)
    splitEl.classList.remove('mmd-split--dragging')
    saveSplit(splitRatio)
  }
  dividerEl.addEventListener('pointermove', onMove)
  dividerEl.addEventListener('pointerup', onUp)
  dividerEl.addEventListener('pointercancel', onUp)
})

dividerEl.addEventListener('dblclick', () => {
  splitRatio = DEFAULT_SPLIT
  applySplit(splitRatio)
  saveSplit(splitRatio)
})

// --- edit wiring ------------------------------------------------------------------

sourceEl.addEventListener('input', () => {
  const src = sourceEl.value
  renderer.schedule(() => src)
  saver.schedule(() => src)
})

// --- boot -------------------------------------------------------------------------

async function readHostTheme(): Promise<unknown> {
  try {
    return await host?.theme.get()
  } catch {
    return undefined
  }
}

async function readStored(key: string): Promise<unknown> {
  try {
    return await host?.storage.panel.get(key)
  } catch {
    return undefined
  }
}

void (async () => {
  const [theme, storedSource, storedOptions, storedSplit] = await Promise.all([
    readHostTheme(),
    readStored(SOURCE_KEY),
    readStored(OPTIONS_KEY),
    readStored(SPLIT_KEY),
  ])
  // Chrome: map the host palette onto the kit's --cate-* tokens.
  applyTheme((theme ?? null) as Parameters<typeof applyTheme>[0])
  // Diagram: 'auto' resolves against the host palette at load; the host bridge
  // exposes no theme-change event today.
  hostTheme = theme
  options = sanitizeStoredOptions(storedOptions)
  themeSel.value = options.theme
  initMermaid()
  splitRatio = sanitizeStoredSplit(storedSplit) ?? DEFAULT_SPLIT
  applySplit(splitRatio)
  sourceEl.value = sanitizeStoredSource(storedSource) ?? DEFAULT_SOURCE
  await renderDiagram(sourceEl.value)
})()
