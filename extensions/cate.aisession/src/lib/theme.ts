// =============================================================================
// Theme sync. Cate hands us its palette via `cate.theme.get()` — a map of CSS
// variable names (without the leading `--`) to values. We mirror every entry
// onto :root so styles.css can reference Cate's real tokens (var(--surface-1),
// var(--text-primary), …) and match the rest of the app. Outside Cate (a plain
// browser, e.g. during dev) the fallbacks in styles.css take over.
// =============================================================================

const cateApi = (globalThis as { cate?: CateHost }).cate

function apply(theme: CateHostTheme): void {
  const root = document.documentElement
  root.dataset.theme = theme.type
  for (const [key, value] of Object.entries(theme.app ?? {})) {
    if (value) root.style.setProperty(`--${key}`, value)
  }
}

/** Apply Cate's theme once. Safe to call outside Cate (no-op). */
export async function initTheme(): Promise<void> {
  if (!cateApi) return
  try {
    apply(await cateApi.theme.get())
  } catch {
    /* keep the stylesheet defaults */
  }
}
