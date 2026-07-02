#!/usr/bin/env node
// =============================================================================
// Tiny real MCP server over stdio, used as a spawn target by the vitest suite
// and the manual smoke test. Dev-only: lives under src/test (never shipped in
// dist/) and imports the SDK from this extension's node_modules.
//
//   tools:     echo(text), add(a, b), fail() (always a thrown error),
//              die() (exits the process shortly after responding; crash tests)
//   resource:  fixture://greeting
//   prompt:    greet(name)
// =============================================================================

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const server = new Server(
  { name: 'echo-fixture', version: '0.1.0' },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: 'echo',
      description: 'Echo text back',
      inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'text to echo' } }, required: ['text'] },
    },
    {
      name: 'add',
      description: 'Add two numbers',
      inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
    },
    { name: 'fail', description: 'Always throws', inputSchema: { type: 'object' } },
    { name: 'die', description: 'Exit the process after responding', inputSchema: { type: 'object' } },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, (req) => {
  const name = req.params.name
  const args = req.params.arguments ?? {}
  if (name === 'echo') return { content: [{ type: 'text', text: String(args.text ?? '') }] }
  if (name === 'add') return { content: [{ type: 'text', text: String(Number(args.a) + Number(args.b)) }] }
  if (name === 'fail') throw new Error('fixture failure')
  if (name === 'die') {
    setTimeout(() => process.exit(7), 50)
    return { content: [{ type: 'text', text: 'dying' }] }
  }
  throw new Error(`unknown tool ${name}`)
})

server.setRequestHandler(ListResourcesRequestSchema, () => ({
  resources: [{ uri: 'fixture://greeting', name: 'greeting', mimeType: 'text/plain' }],
}))

server.setRequestHandler(ReadResourceRequestSchema, (req) => {
  if (req.params.uri !== 'fixture://greeting') throw new Error(`unknown resource ${req.params.uri}`)
  return { contents: [{ uri: 'fixture://greeting', mimeType: 'text/plain', text: 'hello from fixture' }] }
})

server.setRequestHandler(ListPromptsRequestSchema, () => ({
  prompts: [{ name: 'greet', description: 'Greet someone', arguments: [{ name: 'name', required: true }] }],
}))

server.setRequestHandler(GetPromptRequestSchema, (req) => {
  if (req.params.name !== 'greet') throw new Error(`unknown prompt ${req.params.name}`)
  const who = req.params.arguments?.name ?? 'world'
  return { messages: [{ role: 'user', content: { type: 'text', text: `Say hello to ${who}.` } }] }
})

console.error('echo-fixture starting')
await server.connect(new StdioServerTransport())
