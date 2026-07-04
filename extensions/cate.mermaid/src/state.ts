// =============================================================================
// Pure glue helpers: map the host theme to Mermaid's, sanitize the stored
// source / render options / split ratio before restoring them, and normalize
// render/parse failures into a display string. Kept free of DOM, mermaid, and
// host APIs so they can be unit-tested in node.
// =============================================================================

export type MermaidTheme = 'default' | 'dark' | 'forest' | 'neutral'
export type ThemeChoice = 'auto' | MermaidTheme

export interface RenderOptions {
  theme: ThemeChoice
}

export const DEFAULT_OPTIONS: RenderOptions = { theme: 'auto' }

const THEME_CHOICES: readonly ThemeChoice[] = ['auto', 'default', 'dark', 'forest', 'neutral']

/** The starter diagram shown when a panel has no saved source yet. */
export const DEFAULT_SOURCE = `flowchart TD
  A[Open panel] --> B{Saved diagram?}
  B -- yes --> C[Restore it]
  B -- no --> D[Show this example]
  C --> E[Edit on the left]
  D --> E
  E --> F[Live preview on the right]
`

/** Map whatever `cate.theme.get()` returned (or a failure fallback) to the
 *  mermaid theme name: light hosts get mermaid's 'default', everything else
 *  (dark, missing bridge, malformed payload) gets 'dark'. */
export function mermaidThemeFromHost(theme: unknown): MermaidTheme {
  return isRecord(theme) && theme.type === 'light' ? 'default' : 'dark'
}

/** The mermaid theme to render with: an explicit user pick wins, 'auto'
 *  follows the host palette. */
export function resolveMermaidTheme(choice: ThemeChoice, hostTheme: unknown): MermaidTheme {
  return choice === 'auto' ? mermaidThemeFromHost(hostTheme) : choice
}

/** Restore stored render options, dropping anything unrecognized (foreign
 *  JSON, options from a newer/older version) back to the defaults. */
export function sanitizeStoredOptions(raw: unknown): RenderOptions {
  if (!isRecord(raw)) return { ...DEFAULT_OPTIONS }
  const theme = THEME_CHOICES.includes(raw.theme as ThemeChoice)
    ? (raw.theme as ThemeChoice)
    : DEFAULT_OPTIONS.theme
  return { theme }
}

/** Source pane share of the split, as a fraction of the panel width. */
export const DEFAULT_SPLIT = 0.42
export const SPLIT_MIN = 0.15
export const SPLIT_MAX = 0.85

export function clampSplit(ratio: number): number {
  return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, ratio))
}

/** Restore a stored split ratio, or null (= use the default) when the stored
 *  value is missing or not a usable finite number. */
export function sanitizeStoredSplit(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  return clampSplit(raw)
}

/**
 * Turn the raw stored value into editor source, or null (= start with the
 * default example). The stored payload is the plain diagram text; anything
 * else (missing key, foreign/hand-edited JSON, empty string) must never crash
 * the panel and falls back to the example.
 */
export function sanitizeStoredSource(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  if (raw.trim().length === 0) return null
  return raw
}

/**
 * Normalize a mermaid.parse / mermaid.render failure into one displayable
 * string. Mermaid throws Error subclasses whose `message` carries the line and
 * expectation info; anything non-Error is stringified defensively.
 */
export function renderErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message.trim()
  if (typeof err === 'string' && err.trim()) return err.trim()
  return 'Diagram failed to render.'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
