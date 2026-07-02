// =============================================================================
// Pure glue helpers: map the host theme to Excalidraw's, and sanitize a stored
// scene payload before handing it to <Excalidraw initialData>. Kept free of DOM
// and host APIs so they can be unit-tested in node.
// =============================================================================

export type Theme = 'light' | 'dark'

/** Map whatever `cate.theme.get()` returned (or a failure fallback) to a theme. */
export function themeFromHost(theme: unknown): Theme {
  return isRecord(theme) && theme.type === 'light' ? 'light' : 'dark'
}

export interface RestoredScene {
  elements: unknown[]
  appState: Record<string, unknown>
  files?: Record<string, unknown>
  scrollToContent: true
}

/**
 * Turn the raw stored value into a scene Excalidraw can safely restore, or
 * undefined (= start with an empty board). Corrupt JSON, wrong top-level shape,
 * or schema-mismatched fields must never crash the panel:
 *   - `elements` that isn't an array of objects is dropped (empty board);
 *   - `appState.collaborators` is stripped — restored as a plain object it is
 *     not the Map Excalidraw expects and crashes it (serializeAsJSON never
 *     writes it, but stored data may be foreign or hand-edited).
 */
export function sanitizeStoredScene(raw: unknown): RestoredScene | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const elements = Array.isArray(parsed.elements) ? parsed.elements.filter(isRecord) : []
  const { collaborators: _dropped, ...appState } = isRecord(parsed.appState) ? parsed.appState : {}
  return {
    elements,
    appState,
    files: isRecord(parsed.files) ? parsed.files : undefined,
    scrollToContent: true,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
