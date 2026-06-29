// =============================================================================
// Tool call + tool result rendering. A tool_use shows the tool name with a
// one-line summary of its most salient argument (command / path / query …) and
// the full arguments behind a disclosure. A tool_result shows its output in a
// scrollable monospace block, expandable when long.
// =============================================================================

import { useState } from 'react'
import type { Part } from '../parsers/types'

const SUMMARY_KEYS = ['command', 'cmd', 'file_path', 'path', 'filePath', 'query', 'pattern', 'url', 'prompt']

function summarizeInput(input: unknown): string | null {
  if (input == null) return null
  if (typeof input === 'string') return input
  if (typeof input !== 'object') return String(input)
  const obj = input as Record<string, unknown>
  for (const k of SUMMARY_KEYS) {
    if (typeof obj[k] === 'string' && obj[k]) return obj[k] as string
  }
  // Otherwise the first short string value.
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
  const hasDetail = part.input != null && (typeof part.input !== 'string' || part.input !== summary)
  return (
    <div className="tool tool-use">
      <button className="tool-head" onClick={() => setOpen((o) => !o)} disabled={!hasDetail}>
        <span className="tool-caret">{hasDetail ? (open ? '▾' : '▸') : '•'}</span>
        <span className="tool-name">{part.name}</span>
        {summary && <span className="tool-summary">{summary}</span>}
      </button>
      {open && hasDetail && <pre className="tool-body">{prettyJson(part.input)}</pre>}
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
    <div className={`tool tool-result${part.isError ? ' tool-error' : ''}`}>
      <div className="tool-head static">
        <span className="tool-name">{part.isError ? 'error' : 'result'}</span>
      </div>
      <pre className="tool-body">{shown}{long && !open ? '\n…' : ''}</pre>
      {long && (
        <button className="tool-more" onClick={() => setOpen((o) => !o)}>
          {open ? 'Show less' : `Show ${lines.length - 12} more lines`}
        </button>
      )}
    </div>
  )
}
