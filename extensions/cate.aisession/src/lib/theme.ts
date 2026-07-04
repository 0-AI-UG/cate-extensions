// =============================================================================
// Theme sync. This panel styles against Cate's *raw* token names
// (var(--surface-1), var(--text-primary), …) so it matches the rest of the app,
// rather than the kit's curated --cate-* contract. The raw-token mirror lives
// in the kit now (initHostTokens / mirrorHostTokens), so the bridge isn't
// re-hand-rolled here; styles.css still owns the token names and fallbacks.
// =============================================================================

export { initHostTokens as initTheme } from '../_kit/theme'
