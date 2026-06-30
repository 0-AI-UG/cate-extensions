// =============================================================================
// Tool call + tool result rendering, in the agent panel's minimal style: a
// one-line row — the tool's real name plus a mono summary of its most salient
// argument — that expands to an indented body with the raw args and result. No
// bordered card, no caret: the row itself is the control. A standalone
// tool_result (no matching call) still renders as a fallback.
// =============================================================================

import { useState } from 'react'
import type { Part } from '../parsers/types'

const SUMMARY_KEYS = ['command', 'cmd', 'file_path', 'path', 'filePath', 'query', 'pattern', 'url', 'prompt', 'text']

function summarizeInput(input: unknown): string | null {
  if (input == null) return null
  if (typeof input === 'string') return input
  if (typeof input !== 'object') return String(input)
  const obj = input as Record<string, unknown>
  for (const k of SUMMARY_KEYS) {
    if (typeof obj[k] === 'string' && obj[k]) return obj[k] as string
  }
  // Otherwise the first short string value (ids included — they're fine here).
  for (const v of Object.values(obj)) {
    if (typeof v === 'string' && v.length <= 200) return v
  }
  return null
}

function prettyJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

export function ToolUse({ part }: { part: Extract<Part, { kind: 'tool_use' }> }) {
  const [open, setOpen] = useState(false)
  const summary = summarizeInput(part.input)
  const hasInput = part.input != null
  const resultText = part.result?.output?.trim() ? part.result.output : ''
  const isError = part.result?.isError === true
  const hasDetail = hasInput || resultText.length > 0

  return (
    <div className="tool">
      <button
        className="tool-head"
        onClick={() => hasDetail && setOpen((o) => !o)}
        disabled={!hasDetail}
      >
        <span className="tool-name">{part.name}</span>
        {summary && <span className="tool-summary">{summary}</span>}
      </button>
      {open && hasDetail && (
        <div className="tool-body">
          {hasInput && <pre className="tool-pre">{prettyJson(part.input)}</pre>}
          {resultText.length > 0 && (
            <pre className={`tool-pre${isError ? ' tool-pre-error' : ''}`}>{resultText}</pre>
          )}
        </div>
      )}
    </div>
  )
}

export function ToolResult({ part }: { part: Extract<Part, { kind: 'tool_result' }> }) {
  const [open, setOpen] = useState(false)
  const text = part.output ?? ''
  const lines = text.split('\n')
  const long = lines.length > 12 || text.length > 1200
  const shown = open || !long ? text : lines.slice(0, 12).join('\n')
  return (
    <div className="tool">
      <div className="tool-head static">
        <span className="tool-name">{part.isError ? 'error' : 'result'}</span>
      </div>
      <div className="tool-body">
        <pre className={`tool-pre${part.isError ? ' tool-pre-error' : ''}`}>
          {shown}
          {long && !open ? '\n…' : ''}
        </pre>
        {long && (
          <button className="tool-more" onClick={() => setOpen((o) => !o)}>
            {open ? 'Show less' : `Show ${lines.length - 12} more lines`}
          </button>
        )}
      </div>
    </div>
  )
}
