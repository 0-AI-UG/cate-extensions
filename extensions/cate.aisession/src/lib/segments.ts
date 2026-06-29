// =============================================================================
// Split message text into prose and embedded-JSON segments. Agents routinely
// append machine context to a turn (e.g. pi's "Workspace state below" + a big
// JSON blob); rendered as Markdown that's an unreadable wall of wrapped text.
// We detect standalone JSON objects/arrays and hand them to a dedicated block so
// they pretty-print (and collapse) instead.
// =============================================================================

export type Segment = { kind: 'text'; text: string } | { kind: 'json'; value: unknown; raw: string }

// Minimum length before a JSON-looking run is treated as a block rather than
// left inline (so a short `{ "x": 1 }` mid-sentence stays prose).
const MIN_JSON_LEN = 40

/** Find the end index (exclusive) of a balanced JSON value starting at `start`
 *  (text[start] is '{' or '['), respecting strings/escapes. Returns -1 if it
 *  never balances. */
function matchEnd(text: string, start: number): number {
  const open = text[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inStr = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return -1
}

/** Break text into ordered prose/JSON segments. Only top-level JSON objects and
 *  arrays that actually parse are extracted; everything else stays text. */
export function extractSegments(text: string): Segment[] {
  const segments: Segment[] = []
  let cursor = 0
  let i = 0

  const pushText = (s: string): void => {
    if (s.length) segments.push({ kind: 'text', text: s })
  }

  while (i < text.length) {
    const c = text[i]
    if (c === '{' || c === '[') {
      const end = matchEnd(text, i)
      if (end > 0 && end - i >= MIN_JSON_LEN) {
        const raw = text.slice(i, end)
        try {
          const value = JSON.parse(raw)
          if (value && typeof value === 'object') {
            pushText(text.slice(cursor, i))
            segments.push({ kind: 'json', value, raw })
            i = end
            cursor = end
            continue
          }
        } catch {
          /* not valid JSON — treat as ordinary text */
        }
      }
    }
    i++
  }
  pushText(text.slice(cursor))
  return segments
}

export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
