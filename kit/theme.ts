// =============================================================================
// Canonical Cate theme bridge for extensions.
//
// Every extension used to re-derive its own CSS variables from
// `cate.theme.get()` with bespoke `pick(...)` guesswork and divergent variable
// names (--tm-*, --sb-*, --dw-*). This is the one place that mapping lives now:
// it reads Cate's theme palette and writes the kit's `--cate-*` tokens (see
// cate-kit.css) onto a root element, plus a `data-cate-theme` attribute so the
// stylesheet can flip light/dark defaults.
//
// Framework-agnostic (no React) so vanilla and React extensions share it.
// =============================================================================

import type { CateHost, CateHostTheme } from './cate-host'

export type ThemeType = 'dark' | 'light'

/** The injected host, read without augmenting global scope (so the kit never
 *  collides with an extension's own ambient `cate` declaration). */
function host(): CateHost | undefined {
  return (globalThis as { cate?: CateHost }).cate
}

/** Map of kit token -> ordered list of Cate `theme.app` keys to try. Cate's
 *  theme.app delivers the full chrome token map (surface-0..6, text-*,
 *  border-subtle/strong, focus-blue, activity-*, git-*, scrollbar-*,
 *  surface-hover*); the trailing aliases keep sparse/older palettes working. */
const TOKEN_SOURCES: Record<string, string[]> = {
  /* Agent-panel surface roles: surface-4 root, surface-0 side wells,
     surface-3 inputs/cards/drawers. */
  '--cate-bg': ['surface-4', 'app-bg', 'editor-bg', 'bg', 'background'],
  '--cate-bg-side': ['surface-0', 'sidebar-bg', 'panel-bg', 'editor-bg'],
  '--cate-bg-elev': ['surface-3', 'panel-bg', 'sidebar-bg', 'titlebar-bg', 'app-bg', 'editor-bg'],
  '--cate-bg-card': ['surface-3', 'surface-2', 'surface', 'panel-bg', 'editor-bg'],
  '--cate-bg-input': ['surface-3', 'input-bg', 'surface-2'],
  '--cate-bg-selected': ['surface-6', 'surface-4', 'surface-2'],
  '--cate-hover': ['surface-hover'],
  '--cate-hover-strong': ['surface-hover-strong'],
  '--cate-fg': ['text-primary', 'app-fg', 'editor-fg', 'fg', 'foreground', 'text'],
  '--cate-fg-secondary': ['text-secondary', 'text-primary'],
  '--cate-muted': ['text-muted', 'fg-muted', 'muted', 'description-fg'],
  '--cate-border': ['border-subtle', 'border', 'panel-border', 'border-muted', 'divider'],
  '--cate-border-strong': ['border-strong', 'border-subtle', 'border'],
  /* The agent accent pair. `agent-rgb`/`agent-light-rgb` are bare "R G B"
     channel triplets (pick() wraps them in rgb()). */
  '--cate-accent': ['agent-rgb', 'focus-blue', 'border-focus', 'accent', 'primary', 'link', 'button-bg'],
  '--cate-accent-light': ['agent-light-rgb', 'agent-rgb', 'focus-blue', 'border-focus'],
  '--cate-accent-fg': ['accent-fg', 'button-fg', 'on-accent'],
  '--cate-danger': ['git-deleted', 'error', 'danger', 'error-fg'],
  '--cate-success': ['activity-green', 'git-added', 'success', 'ok'],
  '--cate-warning': ['activity-orange', 'git-modified', 'warning', 'warn'],
  '--cate-scrollbar': ['scrollbar-thumb'],
  '--cate-scrollbar-hover': ['scrollbar-thumb-hover', 'scrollbar-thumb'],
}

const RGB_TRIPLET = /^\d{1,3}\s+\d{1,3}\s+\d{1,3}$/

function pick(app: Record<string, string>, keys: string[]): string | null {
  for (const k of keys) {
    const v = app[k]
    if (typeof v === 'string' && v.trim()) {
      const value = v.trim()
      /* Channel triplets ("74 158 255") become usable colors. */
      return RGB_TRIPLET.test(value) ? `rgb(${value})` : value
    }
  }
  return null
}

/**
 * Apply a Cate theme onto a root element as `--cate-*` tokens. Missing tokens
 * are left to the stylesheet defaults, so a sparse palette still themes the
 * essentials. Also sets `data-cate-theme="light|dark"` on the root.
 */
export function applyTheme(
  theme: CateHostTheme | null | undefined,
  root: HTMLElement = document.documentElement,
): ThemeType {
  const type: ThemeType = theme?.type === 'light' ? 'light' : 'dark'
  root.setAttribute('data-cate-theme', type)
  const app = theme?.app || {}
  for (const [token, sources] of Object.entries(TOKEN_SOURCES)) {
    const value = pick(app, sources)
    if (value) root.style.setProperty(token, value)
  }
  return type
}

/** Read + apply the current theme once. Falls back to dark defaults on error. */
export async function initTheme(root?: HTMLElement): Promise<ThemeType> {
  try {
    const theme = await host()?.theme.get()
    return applyTheme(theme, root)
  } catch {
    return applyTheme(null, root)
  }
}

/** Just the light/dark flag, for code paths that need the type but not the vars. */
export async function readThemeType(): Promise<ThemeType> {
  try {
    const theme = await host()?.theme.get()
    return theme?.type === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}
