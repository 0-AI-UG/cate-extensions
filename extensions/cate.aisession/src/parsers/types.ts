// =============================================================================
// The normalized conversation model every parser produces. The renderer only
// ever sees this shape — it knows nothing about Claude Code / Codex / pi on-disk
// formats. Keep it small and presentation-oriented: enough to draw a chat, no
// more.
// =============================================================================

export type Source = 'claude' | 'codex' | 'pi' | 'generic'

export type Role = 'user' | 'assistant' | 'system' | 'tool'

/** A tool's output, folded into its originating tool_use for rendering. */
export interface ToolOutcome {
  output: string
  isError?: boolean
}

/** One renderable piece of a message. */
export type Part =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_use'; name: string; input?: unknown; id?: string; result?: ToolOutcome }
  | { kind: 'tool_result'; output: string; name?: string; isError?: boolean; id?: string }
  | { kind: 'image'; alt: string }

export interface Message {
  role: Role
  parts: Part[]
  /** ISO timestamp when known. */
  ts?: string
}

export interface Conversation {
  source: Source
  /** Short human title (first user line / session title), for the panel header. */
  title?: string
  model?: string
  cwd?: string
  messages: Message[]
}

// --- small shared helpers ----------------------------------------------------

/** Parse JSONL into an array of objects, skipping blank/garbage lines. */
export function parseJsonl(raw: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      const o = JSON.parse(s)
      if (o && typeof o === 'object') out.push(o as Record<string, unknown>)
    } catch {
      /* tolerate a partially-written trailing line */
    }
  }
  return out
}

/** Coerce anything into a display string (used for tool results / unknown content). */
export function stringify(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

/** A message whose text is entirely one XML-ish context wrapper the agent
 *  injects (environment_context, permissions, command-name, system-reminder,
 *  local-command-*, …). These are real protocol turns but read as noise in a
 *  chat view, so we de-emphasise them (render collapsed) and never title with
 *  them. */
export function isContextNoise(text: string): boolean {
  const t = text.trim()
  if (!t.startsWith('<')) return false
  // Opens with a lowercase/underscored tag and the whole thing is markup-ish.
  return /^<[a-z][a-z0-9_-]*[\s>/]/i.test(t) && t.endsWith('>')
}

function messageText(m: Message): string {
  return m.parts
    .filter((p): p is Extract<Part, { kind: 'text' }> => p.kind === 'text')
    .map((p) => p.text)
    .join('\n')
}

/** First real (non-noise) user line, trimmed to a one-line title. */
export function deriveTitle(messages: Message[]): string | undefined {
  for (const m of messages) {
    if (m.role !== 'user') continue
    const text = messageText(m)
    if (!text || isContextNoise(text)) continue
    const oneLine = text.replace(/\s+/g, ' ').trim()
    if (!oneLine) continue
    return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine
  }
  return undefined
}

/** Reclassify user turns that are pure injected context as `system`, so the
 *  view can collapse them. Applied uniformly across formats. */
export function reclassifyContextNoise(messages: Message[]): Message[] {
  return messages.map((m) => {
    if (m.role !== 'user') return m
    const text = messageText(m)
    return text && isContextNoise(text) ? { ...m, role: 'system' } : m
  })
}

/** Fold each tool_result into its originating tool_use (matched by id) so a call
 *  and its output render as a single card — no standalone "result" rows (which,
 *  when a tool returns nothing, read as stray dividers between turns). Results
 *  with no matching call are left in place so nothing is silently dropped. */
export function pairToolResults(messages: Message[]): Message[] {
  // First id wins, mirroring the on-disk call→result ordering.
  const resultById = new Map<string, Extract<Part, { kind: 'tool_result' }>>()
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.kind === 'tool_result' && p.id && !resultById.has(p.id)) resultById.set(p.id, p)
    }
  }

  const consumed = new Set<string>()
  const out: Message[] = []
  for (const m of messages) {
    const parts = m.parts.map((p) => {
      if (p.kind !== 'tool_use' || !p.id) return p
      const r = resultById.get(p.id)
      if (!r) return p
      consumed.add(p.id)
      return { ...p, result: { output: r.output, isError: r.isError } }
    })
    // Drop the now-folded standalone results; keep any unmatched ones.
    const kept = parts.filter((p) => !(p.kind === 'tool_result' && p.id && consumed.has(p.id)))
    if (kept.length > 0) out.push({ ...m, parts: kept })
  }
  return out
}

/** Drop messages that ended up with nothing renderable. */
export function pruneEmpty(messages: Message[]): Message[] {
  return messages.filter((m) =>
    m.parts.some((p) => {
      if (p.kind === 'text' || p.kind === 'thinking') return p.text.trim().length > 0
      return true
    }),
  )
}
