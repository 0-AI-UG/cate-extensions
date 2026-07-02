// =============================================================================
// Parser contract tests. Inline fixtures mirror the real on-disk shapes (sampled
// from ~/.claude, ~/.codex, and <project>/.cate/pi-agent) so detection +
// normalization stay correct without committing real transcripts.
// =============================================================================

import { describe, it, expect } from 'vitest'
import { parseSession, detectSource } from './index'
import { parseJsonl } from './types'

const jsonl = (rows: unknown[]): string => rows.map((r) => JSON.stringify(r)).join('\n')

describe('detectSource', () => {
  it('recognizes each agent format', () => {
    expect(detectSource(parseJsonl(jsonl([{ type: 'mode' }, { type: 'assistant', message: { role: 'assistant', content: [] } }])))).toBe('claude')
    expect(detectSource(parseJsonl(jsonl([{ type: 'session_meta', payload: {} }])))).toBe('codex')
    expect(detectSource(parseJsonl(jsonl([{ type: 'session', version: 3, id: 'x' }])))).toBe('pi')
    expect(detectSource(parseJsonl(jsonl([{ hello: 'world' }])))).toBeNull()
  })
})

describe('Claude Code', () => {
  const fixture = jsonl([
    { type: 'mode', mode: 'normal' },
    { type: 'user', isMeta: true, message: { role: 'user', content: '<local-command-caveat>noise</local-command-caveat>' } },
    { type: 'user', message: { role: 'user', content: 'Add a button' } },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-8',
        content: [
          { type: 'thinking', thinking: 'plan it' },
          { type: 'text', text: 'On it.' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file.txt' }] } },
  ])

  it('parses model, drops meta turns, maps blocks, folds the result into its call', () => {
    const c = parseSession(fixture)
    expect(c.source).toBe('claude')
    expect(c.model).toBe('claude-opus-4-8')
    expect(c.title).toBe('Add a button')
    // The tool result (tool_use_id t1) folds into the assistant's tool_use, so the
    // trailing tool-result-only user turn is gone: just user + assistant remain.
    expect(c.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    const assistant = c.messages[1]
    expect(assistant.parts.map((p) => p.kind)).toEqual(['thinking', 'text', 'tool_use'])
    expect(assistant.parts[2]).toMatchObject({ kind: 'tool_use', name: 'Bash', result: { output: 'file.txt' } })
  })
})

describe('Codex', () => {
  const fixture = jsonl([
    { timestamp: 't0', type: 'session_meta', payload: { id: 'x', cwd: '/repo' } },
    { timestamp: 't1', type: 'event_msg', payload: { type: 'task_started' } },
    { timestamp: 't2', type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions>env</permissions>' }] } },
    { timestamp: 't3', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the bug' }] } },
    { timestamp: 't4', type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking' }] } },
    { timestamp: 't5', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"pwd"}', call_id: 'c1' } },
    { timestamp: 't6', type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: '/repo' } },
    { timestamp: 't7', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] } },
  ])

  it('parses cwd, reasoning, tool calls in stream order, folds output into its call', () => {
    const c = parseSession(fixture)
    expect(c.source).toBe('codex')
    expect(c.cwd).toBe('/repo')
    expect(c.title).toBe('Fix the bug')
    // function_call_output (call_id c1) folds into the function_call, so the
    // standalone tool row is gone.
    expect(c.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'assistant', 'assistant'])
    expect(c.messages[2].parts[0]).toMatchObject({ kind: 'thinking' })
    expect(c.messages[3].parts[0]).toMatchObject({ kind: 'tool_use', name: 'exec_command', input: { cmd: 'pwd' }, result: { output: '/repo' } })
    expect(c.messages[4].parts[0]).toMatchObject({ kind: 'text', text: 'Done.' })
  })
})

describe('pi', () => {
  const fixture = jsonl([
    { type: 'session', version: 3, id: 'x', cwd: '/repo' },
    { type: 'model_change', provider: 'openai-codex', modelId: 'gpt-5.5' },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello!' }] } },
  ])

  it('parses provider/model and turns', () => {
    const c = parseSession(fixture)
    expect(c.source).toBe('pi')
    expect(c.model).toBe('openai-codex/gpt-5.5')
    expect(c.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('maps pi-ai tool calls (toolCall/arguments) and toolResult messages', () => {
    // pi names tool calls `toolCall` (args under `arguments`) and persists tool
    // results as their own `toolResult`-role message — not the Anthropic shape.
    const c = parseSession(jsonl([
      { type: 'session', version: 3, id: 'x', cwd: '/repo' },
      { type: 'model_change', provider: 'openai-codex', modelId: 'gpt-5.5' },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'read it' }] } },
      { type: 'message', message: { role: 'assistant', content: [
        { type: 'thinking', thinking: 'let me look' },
        { type: 'toolCall', id: 't1', name: 'read_file', arguments: { path: '/a.ts' } },
      ] } },
      { type: 'message', message: { role: 'toolResult', toolCallId: 't1', toolName: 'read_file', isError: false, content: [{ type: 'text', text: 'contents' }] } },
      { type: 'message', message: { role: 'toolResult', toolCallId: 't2', toolName: 'bash', isError: true, content: [{ type: 'text', text: 'boom' }] } },
    ]))
    // t1 folds into the matching read_file call; t2 has no matching call, so it
    // stays as a standalone tool row (nothing is silently dropped).
    expect(c.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
    expect(c.messages[1].parts.map((p) => p.kind)).toEqual(['thinking', 'tool_use'])
    expect(c.messages[1].parts[1]).toMatchObject({
      kind: 'tool_use', name: 'read_file', input: { path: '/a.ts' }, result: { output: 'contents', isError: false },
    })
    expect(c.messages[2].parts[0]).toMatchObject({ kind: 'tool_result', name: 'bash', isError: true })
  })
})

describe('tool-result folding (no stray "result" dividers)', () => {
  it('folds every pi tool result into its call and drops empty turns', () => {
    // Mirrors a real chat-widget session: two read_terminal calls + results, a
    // remark + ack result, and an empty trailing assistant turn. Previously each
    // result rendered as its own card (empty ones looked like dividers).
    const c = parseSession(jsonl([
      { type: 'session', version: 3, id: 'x', cwd: '/repo' },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'state below' }] } },
      { type: 'message', message: { role: 'assistant', content: [
        { type: 'thinking', thinking: 'look' },
        { type: 'toolCall', id: 'a', name: 'read_terminal', arguments: { terminalId: 'a' } },
        { type: 'toolCall', id: 'b', name: 'read_terminal', arguments: { terminalId: 'b' } },
      ] } },
      { type: 'message', message: { role: 'toolResult', toolCallId: 'a', toolName: 'read_terminal', isError: false, content: [{ type: 'text', text: 'out-a' }] } },
      { type: 'message', message: { role: 'toolResult', toolCallId: 'b', toolName: 'read_terminal', isError: false, content: [{ type: 'text', text: '' }] } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '' }, { type: 'toolCall', id: 'c', name: 'remark', arguments: { text: 'idle' } }] } },
      { type: 'message', message: { role: 'toolResult', toolCallId: 'c', toolName: 'remark', isError: false, content: [{ type: 'text', text: '{"ok":true}' }] } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '' }] } },
    ]))
    // No standalone tool rows survive; the empty assistant turn is gone.
    expect(c.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant'])
    expect(c.messages.some((m) => m.parts.some((p) => p.kind === 'tool_result'))).toBe(false)
    // Each call carries its own result (even the empty one).
    const calls = c.messages.flatMap((m) => m.parts).filter((p) => p.kind === 'tool_use')
    expect(calls.map((p: any) => p.result?.output)).toEqual(['out-a', '', '{"ok":true}'])
  })
})

describe('generic + errors', () => {
  it('parses a plain JSON messages array', () => {
    const c = parseSession(JSON.stringify({ messages: [{ role: 'user', content: 'hey' }, { role: 'assistant', content: 'yo' }] }))
    expect(c.source).toBe('generic')
    expect(c.messages).toHaveLength(2)
  })

  it('throws a friendly error on unrecognized content', () => {
    expect(() => parseSession('not json at all')).toThrow(/Unrecognized session file/)
  })
})

describe('robustness', () => {
  it('skips malformed JSONL lines mid-file instead of aborting the session', () => {
    // A truncated write and plain garbage land between two valid Claude turns.
    const text = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'first' } }),
      '{"type":"assistant","message":{"role":"assist', // partially-written line
      'not json at all %%%',
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] } }),
    ].join('\n')
    const c = parseSession(text)
    expect(c.source).toBe('claude')
    expect(c.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('renders a sane fallback for unknown roles and block types, never throws', () => {
    const c = parseSession(jsonl([
      { type: 'session', version: 3, id: 'x', cwd: '/repo' },
      // Unknown role → treated as user rather than dropped.
      { type: 'message', message: { role: 'critic', content: [{ type: 'text', text: 'hm' }] } },
      { type: 'message', message: { role: 'assistant', content: [
        { type: 'hologram', data: 123 }, // unknown block, no text → skipped
        { type: 'server_tool_use', text: 'searched the web' }, // unknown block with text → kept as text
        { type: 'text', text: 'done' },
      ] } },
    ]))
    expect(c.messages[0].role).toBe('user')
    expect(c.messages[1].parts.map((p) => p.kind)).toEqual(['text', 'text'])
    expect(c.messages[1].parts[0]).toMatchObject({ kind: 'text', text: 'searched the web' })
  })

  it('ignores unknown codex response_item payload types', () => {
    const c = parseSession(jsonl([
      { timestamp: 't0', type: 'session_meta', payload: { id: 'x', cwd: '/repo' } },
      { timestamp: 't1', type: 'response_item', payload: { type: 'ghost_item', stuff: true } },
      { timestamp: 't2', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } },
    ]))
    expect(c.source).toBe('codex')
    expect(c.messages.map((m) => m.role)).toEqual(['user'])
  })

  it('throws a friendly error when a recognized file yields no conversation turns', () => {
    // All-bookkeeping Claude file: detection succeeds but every turn is skipped.
    const onlyMeta = jsonl([
      { type: 'mode', mode: 'normal' },
      { type: 'user', isMeta: true, message: { role: 'user', content: 'caveat' } },
    ])
    expect(() => parseSession(onlyMeta)).toThrow(/No conversation turns found/)
  })

  it('rejects non-session JSON (e.g. a package.json) with the supported-formats message', () => {
    expect(() => parseSession(JSON.stringify({ name: 'pkg', version: '1.0.0', scripts: { build: 'vite build' } })))
      .toThrow(/Claude Code, Codex, or pi/)
  })
})
