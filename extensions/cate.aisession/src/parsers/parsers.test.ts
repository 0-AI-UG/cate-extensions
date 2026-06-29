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

  it('parses model, drops meta turns, maps blocks', () => {
    const c = parseSession(fixture)
    expect(c.source).toBe('claude')
    expect(c.model).toBe('claude-opus-4-8')
    expect(c.title).toBe('Add a button')
    // meta caveat is dropped entirely (isMeta), leaving user + assistant + tool result.
    expect(c.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    const assistant = c.messages[1]
    expect(assistant.parts.map((p) => p.kind)).toEqual(['thinking', 'text', 'tool_use'])
    expect(c.messages[2].parts[0]).toMatchObject({ kind: 'tool_result', output: 'file.txt' })
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

  it('parses cwd, reasoning, tool calls/outputs in stream order', () => {
    const c = parseSession(fixture)
    expect(c.source).toBe('codex')
    expect(c.cwd).toBe('/repo')
    expect(c.title).toBe('Fix the bug')
    expect(c.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'assistant', 'tool', 'assistant'])
    expect(c.messages[2].parts[0]).toMatchObject({ kind: 'thinking' })
    expect(c.messages[3].parts[0]).toMatchObject({ kind: 'tool_use', name: 'exec_command', input: { cmd: 'pwd' } })
    expect(c.messages[4].parts[0]).toMatchObject({ kind: 'tool_result', output: '/repo' })
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
    expect(c.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool'])
    expect(c.messages[1].parts.map((p) => p.kind)).toEqual(['thinking', 'tool_use'])
    expect(c.messages[1].parts[1]).toMatchObject({ kind: 'tool_use', name: 'read_file', input: { path: '/a.ts' } })
    expect(c.messages[2].parts[0]).toMatchObject({ kind: 'tool_result', name: 'read_file', output: 'contents', isError: false })
    expect(c.messages[3].parts[0]).toMatchObject({ kind: 'tool_result', name: 'bash', isError: true })
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
