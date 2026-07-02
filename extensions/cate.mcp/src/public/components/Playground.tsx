// Tool playground: schema-derived form for flat schemas, raw JSON editor
// otherwise, rendered results by content type, and a per-session invocation
// history. Also hosts the resource-read and prompt-get mini-forms.

import { useMemo, useState } from 'react'
import { buildArgsFromForm, classifySchema, summarizeSchema, type FormField } from '../../shared/schema-form'
import type { PromptInfo, ToolCallResponse, ToolInfo } from '../../shared/types'
import { callTool, getPrompt, readResource } from '../api'
import { InlineError } from './util'

export interface HistoryEntry {
  at: number
  kind: 'tool' | 'resource' | 'prompt'
  label: string
  ok: boolean
  durationMs?: number
}

function ResultBlocks({ blocks }: { blocks: { type: string; text?: string; src?: string }[] }) {
  return (
    <>
      {blocks.map((block, i) =>
        block.type === 'image' && block.src ? (
          <img className="mcp-play__img" key={i} src={block.src} alt="tool result" />
        ) : (
          <pre className="cate-pre" key={i}>
            {block.text ?? ''}
          </pre>
        ),
      )}
    </>
  )
}

function FieldInput({ field, value, onChange }: { field: FormField; value: string; onChange: (v: string) => void }) {
  if (field.type === 'boolean') {
    return (
      <select className="cate-select" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{field.required ? 'false (default)' : '(omit)'}</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    )
  }
  if (field.type === 'enum') {
    return (
      <select className="cate-select" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{field.required ? '(choose)' : '(omit)'}</option>
        {(field.enumValues ?? []).map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    )
  }
  return (
    <input
      className="cate-input mcp-mono"
      value={value}
      placeholder={field.type === 'string' ? '' : field.type}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

export function ToolPlayground({
  server,
  tool,
  onHistory,
}: {
  server: string
  tool: ToolInfo
  onHistory: (entry: HistoryEntry) => void
}) {
  const plan = useMemo(() => classifySchema(tool.inputSchema), [tool.inputSchema])
  const [values, setValues] = useState<Record<string, string>>({})
  const [jsonText, setJsonText] = useState('{}')
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<ToolCallResponse | null>(null)

  async function run(): Promise<void> {
    setError(null)
    let args: Record<string, unknown>
    if (plan.kind === 'form') {
      const built = buildArgsFromForm(plan.fields, values)
      if (!built.ok) {
        setError(built.error)
        return
      }
      args = built.args
    } else if (plan.kind === 'json') {
      try {
        const parsed: unknown = JSON.parse(jsonText.trim() === '' ? '{}' : jsonText)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          setError('arguments must be a JSON object')
          return
        }
        args = parsed as Record<string, unknown>
      } catch (err) {
        setError(`invalid JSON: ${err instanceof Error ? err.message : String(err)}`)
        return
      }
    } else {
      args = {}
    }
    setRunning(true)
    const res = await callTool(server, tool.name, args)
    setRunning(false)
    setResult(res)
    if (!res.ok) setError(res.error ?? 'call failed')
    onHistory({ at: Date.now(), kind: 'tool', label: tool.name, ok: res.ok && res.isError !== true, durationMs: res.durationMs })
  }

  return (
    <div className="mcp-play">
      <div className="mcp-inv__schema">{summarizeSchema(tool.inputSchema)}</div>
      {plan.kind === 'form' && (
        <div className="mcp-play__form">
          {plan.fields.map((field) => (
            <label className="cate-field" key={field.name}>
              <span className="cate-label">
                {field.name}
                {field.required ? '' : ' (optional)'}
              </span>
              <FieldInput
                field={field}
                value={values[field.name] ?? ''}
                onChange={(v) => setValues((prev) => ({ ...prev, [field.name]: v }))}
              />
              {field.description && <span className="mcp-muted">{field.description}</span>}
            </label>
          ))}
        </div>
      )}
      {plan.kind === 'json' && (
        <label className="cate-field">
          <span className="cate-label">Arguments (JSON)</span>
          <textarea className="cate-input mcp-mono" rows={5} value={jsonText} onChange={(e) => setJsonText(e.target.value)} />
        </label>
      )}
      {plan.kind === 'none' && <div className="mcp-muted">No arguments</div>}
      <div>
        <button className="cate-btn cate-btn--primary" type="button" disabled={running} onClick={() => void run()}>
          {running ? 'Calling…' : 'Call tool'}
        </button>
      </div>
      <InlineError error={error} />
      {result?.ok && (
        <div className={`mcp-play__result${result.isError ? ' mcp-play__result--error' : ''}`}>
          <div className="mcp-play__meta">
            {result.isError ? 'Tool returned an error' : 'Result'} · {result.durationMs ?? 0}ms
          </div>
          <ResultBlocks blocks={result.content ?? []} />
          {result.structuredContent !== undefined && (
            <pre className="cate-pre">{JSON.stringify(result.structuredContent, null, 2)}</pre>
          )}
        </div>
      )}
    </div>
  )
}

export function ResourcePlayground({
  server,
  initialUri,
  onHistory,
}: {
  server: string
  /** Pre-fill from a clicked resource row; editable for templated URIs. */
  initialUri?: string
  onHistory: (e: HistoryEntry) => void
}) {
  const [uri, setUri] = useState(initialUri ?? '')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [blocks, setBlocks] = useState<{ type: string; text?: string; src?: string }[] | null>(null)

  async function run(): Promise<void> {
    if (uri.trim() === '') {
      setError('enter a resource URI')
      return
    }
    setError(null)
    setRunning(true)
    const res = await readResource(server, uri.trim())
    setRunning(false)
    if (!res.ok) {
      setError(res.error ?? 'read failed')
      setBlocks(null)
    } else {
      setBlocks(res.contents ?? [])
    }
    onHistory({ at: Date.now(), kind: 'resource', label: uri.trim(), ok: res.ok, durationMs: res.durationMs })
  }

  return (
    <div className="mcp-play">
      <div className="mcp-searchbar">
        <input
          className="cate-input mcp-mono"
          value={uri}
          placeholder="resource URI"
          onChange={(e) => setUri(e.target.value)}
        />
        <button className="cate-btn cate-btn--primary" type="button" disabled={running} onClick={() => void run()}>
          {running ? 'Reading…' : 'Read'}
        </button>
      </div>
      <InlineError error={error} />
      {blocks && (
        <div className="mcp-play__result">
          <ResultBlocks blocks={blocks} />
        </div>
      )}
    </div>
  )
}

export function PromptPlayground({
  server,
  prompt,
  onHistory,
}: {
  server: string
  prompt: PromptInfo
  onHistory: (e: HistoryEntry) => void
}) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [messages, setMessages] = useState<{ role: string; content: { type: string; text?: string; src?: string } }[] | null>(null)

  async function run(): Promise<void> {
    setError(null)
    const args: Record<string, string> = {}
    for (const arg of prompt.arguments ?? []) {
      const v = values[arg.name] ?? ''
      if (v === '' && arg.required) {
        setError(`"${arg.name}" is required`)
        return
      }
      if (v !== '') args[arg.name] = v
    }
    setRunning(true)
    const res = await getPrompt(server, prompt.name, args)
    setRunning(false)
    if (!res.ok) {
      setError(res.error ?? 'prompt failed')
      setMessages(null)
    } else {
      setMessages(res.messages ?? [])
    }
    onHistory({ at: Date.now(), kind: 'prompt', label: prompt.name, ok: res.ok, durationMs: res.durationMs })
  }

  return (
    <div className="mcp-play">
      {(prompt.arguments ?? []).map((arg) => (
        <label className="cate-field" key={arg.name}>
          <span className="cate-label">
            {arg.name}
            {arg.required ? '' : ' (optional)'}
          </span>
          <input
            className="cate-input"
            value={values[arg.name] ?? ''}
            onChange={(e) => setValues((prev) => ({ ...prev, [arg.name]: e.target.value }))}
          />
          {arg.description && <span className="mcp-muted">{arg.description}</span>}
        </label>
      ))}
      <div>
        <button className="cate-btn cate-btn--primary" type="button" disabled={running} onClick={() => void run()}>
          {running ? 'Fetching…' : 'Get prompt'}
        </button>
      </div>
      <InlineError error={error} />
      {messages && (
        <div className="mcp-play__result">
          {messages.map((m, i) => (
            <div key={i}>
              <div className="mcp-play__meta">{m.role}</div>
              <ResultBlocks blocks={[m.content]} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
