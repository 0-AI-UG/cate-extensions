import { describe, expect, it, afterEach } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { createAggregateServer, type AggregateSource, type UpstreamConnection } from './aggregate'

interface TestUpstream extends UpstreamConnection {
  close(): Promise<void>
}

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn().catch(() => undefined)))
})

/** A REAL MCP server over InMemoryTransport, wrapped as an upstream. */
async function makeUpstream(name: string): Promise<TestUpstream> {
  const server = new Server({ name, version: '0.0.1' }, { capabilities: { tools: {}, resources: {}, prompts: {} } })
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      { name: 'greet', inputSchema: { type: 'object' } },
      { name: 'boom', inputSchema: { type: 'object' } },
      { name: 'multi__part', inputSchema: { type: 'object' } },
    ],
  }))
  server.setRequestHandler(CallToolRequestSchema, (req) => {
    if (req.params.name === 'greet') return { content: [{ type: 'text', text: `hello from ${name}` }] }
    if (req.params.name === 'multi__part') return { content: [{ type: 'text', text: `multi ${name}` }] }
    throw new Error(`${name} exploded`)
  })
  server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: [{ uri: `mem://${name}/data`, name: 'data' }],
  }))
  server.setRequestHandler(ReadResourceRequestSchema, (req) => ({
    contents: [{ uri: req.params.uri, mimeType: 'text/plain', text: `resource of ${name}` }],
  }))
  server.setRequestHandler(ListPromptsRequestSchema, () => ({ prompts: [{ name: 'p' }] }))
  server.setRequestHandler(GetPromptRequestSchema, () => ({
    messages: [{ role: 'user', content: { type: 'text', text: `prompt of ${name}` } }],
  }))

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'upstream-client', version: '0' })
  await client.connect(clientTransport)
  const upstream: TestUpstream = {
    name,
    // The aggregator serves lists from the manager's CACHED inventory.
    tools: [
      { name: 'greet', description: 'greets', inputSchema: { type: 'object' } },
      { name: 'boom', inputSchema: { type: 'object' } },
      { name: 'multi__part', inputSchema: { type: 'object' } },
    ],
    resources: [{ uri: `mem://${name}/data`, name: 'data' }],
    prompts: [{ name: 'p', description: 'a prompt' }],
    activeClient: client,
    close: () => client.close(),
  }
  cleanups.push(() => upstream.close())
  return upstream
}

async function makeAggregateClient(source: AggregateSource): Promise<Client> {
  const aggServer = createAggregateServer(source)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await aggServer.connect(serverTransport)
  const client = new Client({ name: 'agg-client', version: '0' })
  await client.connect(clientTransport)
  cleanups.push(() => client.close())
  return client
}

describe('unified endpoint aggregation', () => {
  it('lists tools of every running upstream, namespaced <server>__<tool>', async () => {
    const a = await makeUpstream('alpha')
    const b = await makeUpstream('beta')
    const client = await makeAggregateClient({ activeConnections: () => [a, b] })
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name)
    expect(names).toContain('alpha__greet')
    expect(names).toContain('beta__greet')
    expect(names).toContain('alpha__multi__part')
    expect(tools.find((t) => t.name === 'alpha__greet')?.description).toBe('greets')
  })

  it('forwards calls to the right upstream (first-separator split)', async () => {
    const a = await makeUpstream('alpha')
    const b = await makeUpstream('beta')
    const client = await makeAggregateClient({ activeConnections: () => [a, b] })
    const r1 = (await client.callTool({ name: 'beta__greet', arguments: {} })) as { content: { text: string }[] }
    expect(r1.content[0].text).toBe('hello from beta')
    // Tool name itself contains __; server names cannot, so routing still works.
    const r2 = (await client.callTool({ name: 'alpha__multi__part', arguments: {} })) as { content: { text: string }[] }
    expect(r2.content[0].text).toBe('multi alpha')
  })

  it('propagates upstream failures as tool errors, not protocol crashes', async () => {
    const a = await makeUpstream('alpha')
    const client = await makeAggregateClient({ activeConnections: () => [a] })
    const result = (await client.callTool({ name: 'alpha__boom', arguments: {} })) as {
      isError?: boolean
      content: { text: string }[]
    }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('alpha')
    // The session survived: a follow-up call still works.
    const ok = (await client.callTool({ name: 'alpha__greet', arguments: {} })) as { content: { text: string }[] }
    expect(ok.content[0].text).toBe('hello from alpha')
  })

  it('rejects unknown servers, unknown tools and un-namespaced names', async () => {
    const a = await makeUpstream('alpha')
    const client = await makeAggregateClient({ activeConnections: () => [a] })
    await expect(client.callTool({ name: 'ghost__greet', arguments: {} })).rejects.toThrow(/not running/)
    await expect(client.callTool({ name: 'alpha__ghost', arguments: {} })).rejects.toThrow(/no tool/)
    await expect(client.callTool({ name: 'plainname', arguments: {} })).rejects.toThrow(/namespaced/)
  })

  it('lists and reads resources, routed by URI ownership', async () => {
    const a = await makeUpstream('alpha')
    const b = await makeUpstream('beta')
    const client = await makeAggregateClient({ activeConnections: () => [a, b] })
    const { resources } = await client.listResources()
    expect(resources.map((r) => r.name)).toEqual(expect.arrayContaining(['alpha__data', 'beta__data']))
    const read = await client.readResource({ uri: 'mem://beta/data' })
    expect((read.contents[0] as { text: string }).text).toBe('resource of beta')
    await expect(client.readResource({ uri: 'mem://ghost/data' })).rejects.toThrow(/no running server/)
  })

  it('lists and gets prompts, namespaced like tools', async () => {
    const a = await makeUpstream('alpha')
    const client = await makeAggregateClient({ activeConnections: () => [a] })
    const { prompts } = await client.listPrompts()
    expect(prompts.map((p) => p.name)).toContain('alpha__p')
    const got = await client.getPrompt({ name: 'alpha__p', arguments: {} })
    expect((got.messages[0].content as { text: string }).text).toBe('prompt of alpha')
    await expect(client.getPrompt({ name: 'alpha__ghost', arguments: {} })).rejects.toThrow(/no prompt/)
  })

  it('reflects upstream set changes on the next list (enabled+running only)', async () => {
    const a = await makeUpstream('alpha')
    const b = await makeUpstream('beta')
    let connections: UpstreamConnection[] = [a]
    const client = await makeAggregateClient({ activeConnections: () => connections })
    expect((await client.listTools()).tools.some((t) => t.name.startsWith('beta__'))).toBe(false)
    connections = [a, b]
    expect((await client.listTools()).tools.some((t) => t.name.startsWith('beta__'))).toBe(true)
    connections = []
    expect((await client.listTools()).tools).toEqual([])
  })

  it('declares listChanged and can push the notification to a session', async () => {
    const a = await makeUpstream('alpha')
    const aggServer = createAggregateServer({ activeConnections: () => [a] })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await aggServer.connect(serverTransport)
    const client = new Client({ name: 'agg-client', version: '0' })
    let notified = 0
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      notified++
    })
    await client.connect(clientTransport)
    cleanups.push(() => client.close())
    expect(client.getServerCapabilities()?.tools?.listChanged).toBe(true)
    await aggServer.sendToolListChanged()
    await new Promise((r) => setTimeout(r, 50))
    expect(notified).toBe(1)
  })
})
