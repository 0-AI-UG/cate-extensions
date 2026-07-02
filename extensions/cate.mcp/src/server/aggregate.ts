// =============================================================================
// The unified MCP endpoint: an SDK server at /mcp on the extension's loopback
// port that aggregates every tool/resource/prompt of every enabled+running
// managed server. Tools and prompts are namespaced "<server>__<name>" (server
// names cannot contain "__", so the split is deterministic); resources keep
// their original URIs and are routed by URI ownership. Upstream failures come
// back as TOOL errors (isError results), never protocol crashes, so one bad
// upstream cannot take down a client session. listChanged notifications fan
// out to every connected session when upstream inventories move.
// =============================================================================

import type { IncomingMessage, ServerResponse } from 'http'
import { randomUUID } from 'crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  isInitializeRequest,
  type CallToolResult,
  type GetPromptResult,
  type ListPromptsResult,
  type ListResourcesResult,
  type ListToolsResult,
  type ReadResourceResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { namespaceName, splitNamespacedName } from '../shared/naming'
import type { PromptInfo, ResourceInfo, ToolInfo } from '../shared/types'

/** What the aggregator needs from a managed server (subset of ManagedConnection). */
export interface UpstreamConnection {
  name: string
  tools: ToolInfo[]
  resources: ResourceInfo[]
  prompts: PromptInfo[]
  activeClient: Client | null
}

/** What the aggregator needs from the manager. */
export interface AggregateSource {
  activeConnections(): UpstreamConnection[]
}

function upstreamByName(source: AggregateSource, namespaced: string): { conn: UpstreamConnection; item: string } {
  const split = splitNamespacedName(namespaced)
  if (!split) throw new McpError(ErrorCode.InvalidParams, `"${namespaced}" is not a namespaced name (<server>__<name>)`)
  const conn = source.activeConnections().find((c) => c.name === split.server)
  if (!conn || !conn.activeClient) {
    throw new McpError(ErrorCode.InvalidParams, `server "${split.server}" is not running`)
  }
  return { conn, item: split.item }
}

/** Build one aggregating MCP Server instance (one per client session). */
export function createAggregateServer(source: AggregateSource): Server {
  const server = new Server(
    { name: 'cate-mcp-aggregate', version: '1.0.0' },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true },
        prompts: { listChanged: true },
      },
      instructions:
        'Aggregated MCP endpoint managed by Cate. Tools and prompts are namespaced "<server>__<name>"; each maps to one managed upstream MCP server.',
    },
  )

  server.setRequestHandler(ListToolsRequestSchema, (): ListToolsResult => {
    const tools: Tool[] = []
    for (const conn of source.activeConnections()) {
      for (const tool of conn.tools) {
        tools.push({
          name: namespaceName(conn.name, tool.name),
          description: tool.description ?? `Tool "${tool.name}" of managed server "${conn.name}"`,
          inputSchema: (tool.inputSchema as Tool['inputSchema']) ?? { type: 'object' },
        })
      }
    }
    return { tools }
  })

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { conn, item } = upstreamByName(source, request.params.name)
    const known = conn.tools.some((t) => t.name === item)
    if (!known) throw new McpError(ErrorCode.InvalidParams, `server "${conn.name}" has no tool "${item}"`)
    try {
      const result = await conn.activeClient!.callTool(
        { name: item, arguments: (request.params.arguments as Record<string, unknown>) ?? {} },
        undefined,
        { timeout: 120_000 },
      )
      return result as CallToolResult
    } catch (err) {
      // Upstream failure -> tool error, not a protocol error: the aggregate
      // session must survive one broken upstream.
      return {
        content: [
          {
            type: 'text',
            text: `upstream server "${conn.name}" failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      }
    }
  })

  server.setRequestHandler(ListResourcesRequestSchema, (): ListResourcesResult => {
    const resources: ListResourcesResult['resources'] = []
    for (const conn of source.activeConnections()) {
      for (const res of conn.resources) {
        resources.push({
          uri: res.uri,
          name: namespaceName(conn.name, res.name ?? res.uri),
          description: res.description,
          mimeType: res.mimeType,
        })
      }
    }
    return { resources }
  })

  server.setRequestHandler(ReadResourceRequestSchema, async (request): Promise<ReadResourceResult> => {
    const uri = request.params.uri
    // Route by URI ownership from the cached inventories; first owner wins on
    // the (rare) duplicate URI across servers.
    const conn = source.activeConnections().find((c) => c.resources.some((r) => r.uri === uri))
    if (!conn || !conn.activeClient) {
      throw new McpError(ErrorCode.InvalidParams, `no running server exposes resource "${uri}"`)
    }
    try {
      return (await conn.activeClient.readResource({ uri }, { timeout: 60_000 })) as ReadResourceResult
    } catch (err) {
      throw new McpError(
        ErrorCode.InternalError,
        `upstream server "${conn.name}" failed reading "${uri}": ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  })

  server.setRequestHandler(ListPromptsRequestSchema, (): ListPromptsResult => {
    const prompts: ListPromptsResult['prompts'] = []
    for (const conn of source.activeConnections()) {
      for (const prompt of conn.prompts) {
        prompts.push({
          name: namespaceName(conn.name, prompt.name),
          description: prompt.description,
          arguments: prompt.arguments,
        })
      }
    }
    return { prompts }
  })

  server.setRequestHandler(GetPromptRequestSchema, async (request): Promise<GetPromptResult> => {
    const { conn, item } = upstreamByName(source, request.params.name)
    const known = conn.prompts.some((p) => p.name === item)
    if (!known) throw new McpError(ErrorCode.InvalidParams, `server "${conn.name}" has no prompt "${item}"`)
    try {
      return (await conn.activeClient!.getPrompt(
        { name: item, arguments: (request.params.arguments as Record<string, string>) ?? {} },
        { timeout: 60_000 },
      )) as GetPromptResult
    } catch (err) {
      throw new McpError(
        ErrorCode.InternalError,
        `upstream server "${conn.name}" failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  })

  return server
}

interface Session {
  server: Server
  transport: StreamableHTTPServerTransport
}

/** HTTP-facing aggregator: one Server+transport pair per MCP session. */
export class Aggregator {
  private readonly sessions = new Map<string, Session>()

  constructor(private readonly source: AggregateSource) {}

  /** Fan a list_changed to every connected session (upstreams moved). */
  notifyListsChanged(): void {
    for (const { server } of this.sessions.values()) {
      void server.sendToolListChanged().catch(() => undefined)
      void server.sendResourceListChanged().catch(() => undefined)
      void server.sendPromptListChanged().catch(() => undefined)
    }
  }

  async handleRequest(req: IncomingMessage, res: ServerResponse, parsedBody: unknown): Promise<void> {
    const sessionId = String(req.headers['mcp-session-id'] ?? '')
    const existing = sessionId ? this.sessions.get(sessionId) : undefined
    if (existing) {
      await existing.transport.handleRequest(req, res, parsedBody)
      return
    }
    if (req.method === 'POST' && isInitializeRequest(parsedBody)) {
      const server = createAggregateServer(this.source)
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          this.sessions.set(id, { server, transport })
        },
      })
      transport.onclose = () => {
        if (transport.sessionId) this.sessions.delete(transport.sessionId)
      }
      await server.connect(transport)
      await transport.handleRequest(req, res, parsedBody)
      return
    }
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'missing session; POST an initialize request first' },
        id: null,
      }),
    )
  }

  async close(): Promise<void> {
    for (const { transport } of this.sessions.values()) {
      await transport.close().catch(() => undefined)
    }
    this.sessions.clear()
  }
}
