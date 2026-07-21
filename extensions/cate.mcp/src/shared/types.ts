// =============================================================================
// Types shared between the extension server and the panel. Everything the
// panel renders comes over /api/state as a StateSnapshot; keeping the wire
// shape in one module keeps the two sides honest.
// =============================================================================

/** Where a managed server's process/connection currently is. */
export type ServerStatus =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'degraded'
  | 'restarting'
  | 'error'
  | 'needs-auth'
  | 'disabled'

/** Normalized stdio server config (Claude-Desktop-style entry). */
export interface StdioServerConfig {
  kind: 'stdio'
  command: string
  args: string[]
  env: Record<string, string>
  cwd?: string
  disabled: boolean
}

/** Normalized remote (streamable HTTP / SSE) server config. */
export interface RemoteServerConfig {
  kind: 'remote'
  url: string
  headers: Record<string, string>
  disabled: boolean
}

export type ServerConfig = StdioServerConfig | RemoteServerConfig

/** The editable fields the panel sends when adding/updating a server. */
export interface ServerConfigInput {
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  disabled?: boolean
}

export interface ToolInfo {
  name: string
  description?: string
  inputSchema?: unknown
}

export interface ResourceInfo {
  uri: string
  name?: string
  description?: string
  mimeType?: string
}

export interface PromptArgumentInfo {
  name: string
  description?: string
  required?: boolean
}

export interface PromptInfo {
  name: string
  description?: string
  arguments?: PromptArgumentInfo[]
}

/** Result of the MCP initialize handshake, shown in the detail drawer. */
export interface ServerHandshakeInfo {
  name: string
  version: string
  /** Advertised capability keys ("tools", "resources", "prompts", ...). */
  capabilities: string[]
  instructions?: string
}

/** One managed server as the panel sees it. */
export interface ServerSnapshot {
  name: string
  transport: 'stdio' | 'remote'
  status: ServerStatus
  /** Error message when status is 'error' (or last crash while restarting). */
  error: string | null
  /** Bounded stderr tail of the current stdio run. */
  stderrTail: string[]
  /** Restart attempt counter while backing off ("restarting (n)"). */
  restartAttempt: number
  /** Epoch ms the current run became 'running', for uptime display. */
  startedAt: number | null
  handshake: ServerHandshakeInfo | null
  tools: ToolInfo[]
  resources: ResourceInfo[]
  prompts: PromptInfo[]
  /** OAuth authorization URL when status is 'needs-auth'. */
  authUrl: string | null
  /** Raw (unexpanded) config, for the edit drawer. */
  config: ServerConfigInput
  /** Per-server config parse problem (bad entry in an otherwise valid file). */
  configError: string | null
}

export interface EndpointInfo {
  /** Loopback URL of the aggregating MCP endpoint. */
  url: string
  /** Full Authorization header value clients must send. */
  authHeader: string
}

/** One coding agent the endpoint can be installed into (Endpoint screen). */
export interface AgentTargetStatus {
  id: string
  label: string
  /** Workspace-relative config file path, for display. */
  path: string
  /** False when this agent can't take a workspace-local HTTP MCP config. */
  supported: boolean
  /** Why it's unsupported (shown as a tooltip), when supported is false. */
  reason?: string
  /** Our endpoint entry is present in the agent's config. */
  installed: boolean
  /** Installed, but at a different URL than the current endpoint (needs update). */
  stale: boolean
}

/** Wire shape of GET /api/agents. */
export interface AgentsResponse {
  ok: boolean
  error?: string
  agents?: AgentTargetStatus[]
}

export interface StateSnapshot {
  /** Monotonic change counter; the panel polls with it to skip no-op updates. */
  serial: number
  /** Absolute path of .cate/mcp.json (for the "Edit config file" button). */
  configPath: string
  /** true when .cate/mcp.json exists on disk. */
  initialized: boolean
  /** Whole-file parse error (invalid JSON / wrong shape), or null. */
  configError: string | null
  servers: ServerSnapshot[]
  endpoint: EndpointInfo
  workspaceRoot: string | null
}

/** Wire shape of GET /api/state?known=<serial>. */
export interface StateResponse {
  serial: number
  unchanged?: boolean
  state?: StateSnapshot
}

/** One recorded tool call through the aggregated /mcp endpoint (Activity feed). */
export interface ActivityEntry {
  /** Epoch ms at call start. */
  at: number
  /** Upstream managed server that served the call. */
  server: string
  /** Un-namespaced tool name on that server. */
  tool: string
  durationMs: number
  isError: boolean
  /** Connecting MCP client's advertised name, when known. */
  client?: string
}

/** Wire shape of GET /api/activity?limit=<n>. */
export interface ActivityResponse {
  ok: boolean
  error?: string
  entries?: ActivityEntry[]
  summary?: { total: number; errors: number }
}

/** One playground invocation result content block, pre-digested for the UI. */
export interface ContentBlockView {
  type: 'text' | 'image' | 'json' | 'other'
  text?: string
  /** data URL for images. */
  src?: string
}

export interface ToolCallResponse {
  ok: boolean
  error?: string
  isError?: boolean
  content?: ContentBlockView[]
  structuredContent?: unknown
  durationMs?: number
}

export interface ResourceReadResponse {
  ok: boolean
  error?: string
  contents?: ContentBlockView[]
  durationMs?: number
}

export interface PromptGetResponse {
  ok: boolean
  error?: string
  description?: string
  messages?: { role: string; content: ContentBlockView }[]
  durationMs?: number
}
