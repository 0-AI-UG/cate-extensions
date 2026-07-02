// =============================================================================
// The lifecycle manager: owns the config store, one ManagedConnection per valid
// config entry, the OAuth stores, and the monotonic state serial the panel
// polls with. All config mutations flow through here (snapshot -> mutate doc ->
// atomic write -> hot-apply), and external edits arrive via the store watcher
// and take the same hot-apply path: diff old/new, restart only changed servers.
// =============================================================================

import { AuthStore, FileOAuthProvider, PendingAuthRegistry } from './oauth'
import { ConfigStore, type ConfigSnapshot } from './config-store'
import { ManagedConnection, type ConnectionOptions } from './connection'
import {
  diffConfigs,
  removeServerFromDoc,
  setDisabledInDoc,
  upsertServerInDoc,
  validateConfigInput,
  validateServerName,
  type JsonObject,
  type ParsedConfigDoc,
} from '../shared/config'
import type { ServerConfig, ServerConfigInput, ServerSnapshot, StateSnapshot } from '../shared/types'

export interface ApiError {
  ok: false
  status: number
  error: string
}

export type ApiResult<T = object> = ({ ok: true } & T) | ApiError

function fail(status: number, error: string): ApiError {
  return { ok: false, status, error }
}

export interface ManagerOptions {
  workspaceRoot: string
  /** Loopback port, for the OAuth callback URL and endpoint card. */
  port: number
  /** Bearer token, surfaced on the endpoint card. */
  token: string
  connection?: ConnectionOptions
  /** Autostart enabled servers on boot (tests may disable). */
  autostart?: boolean
}

export class Manager {
  private serialCounter = 1
  readonly store: ConfigStore
  readonly authStore: AuthStore
  readonly pendingAuth = new PendingAuthRegistry()
  private readonly connections = new Map<string, ManagedConnection>()
  private lastParsed: ParsedConfigDoc | null = null
  private configError: string | null = null
  private initialized = false
  private readonly inventoryListeners = new Set<() => void>()
  private readonly opts: ManagerOptions

  constructor(opts: ManagerOptions) {
    this.opts = opts
    this.store = new ConfigStore(opts.workspaceRoot)
    this.authStore = new AuthStore(opts.workspaceRoot)
  }

  get serial(): number {
    return this.serialCounter
  }

  private bump(): void {
    this.serialCounter++
  }

  /** Aggregator subscription: fired when any server's inventory set changed. */
  onInventoryChange(cb: () => void): () => void {
    this.inventoryListeners.add(cb)
    return () => this.inventoryListeners.delete(cb)
  }

  private emitInventoryChange(): void {
    this.bump()
    for (const cb of this.inventoryListeners) {
      try {
        cb()
      } catch {
        /* a listener failure must not break the manager */
      }
    }
  }

  // --- boot / reload -------------------------------------------------------------

  async init(): Promise<void> {
    await this.reload()
    this.store.watch(() => {
      void this.reload()
    })
  }

  async shutdown(): Promise<void> {
    this.store.close()
    await Promise.all([...this.connections.values()].map((c) => c.dispose().catch(() => undefined)))
    this.connections.clear()
  }

  /** Re-read mcp.json and hot-apply. On a parse error the error is surfaced and
   *  running servers are left alone (taskmaster pattern: show the error, keep
   *  watching for recovery, never make things worse). */
  private async reload(): Promise<void> {
    const snap = this.store.read()
    this.initialized = snap.exists
    if (snap.error !== null || snap.parsed === null) {
      this.configError = snap.error ?? 'unreadable config'
      this.bump()
      return
    }
    this.configError = null
    await this.applyParsed(snap.parsed)
    this.bump()
  }

  /** Diff against the previously applied config and touch only what changed. */
  private async applyParsed(parsed: ParsedConfigDoc): Promise<void> {
    const diff = diffConfigs(this.lastParsed, parsed)
    this.lastParsed = parsed
    const work: Promise<void>[] = []
    for (const name of diff.removed) {
      const conn = this.connections.get(name)
      if (conn) {
        this.connections.delete(name)
        work.push(conn.dispose().catch(() => undefined))
      }
    }
    for (const name of [...diff.added, ...diff.changed]) {
      const entry = parsed.servers.get(name)
      if (!entry) continue
      const existing = this.connections.get(name)
      if (!entry.config) {
        // Entry became invalid: stop any previous incarnation; the snapshot
        // surfaces entry.error as a per-server config error.
        if (existing) {
          this.connections.delete(name)
          work.push(existing.dispose().catch(() => undefined))
        }
        continue
      }
      if (existing) {
        existing.setConfig(entry.config)
        work.push(
          entry.config.disabled
            ? existing.stop()
            : existing.restart().catch(() => undefined),
        )
      } else {
        const conn = this.createConnection(name, entry.config)
        this.connections.set(name, conn)
        if (this.opts.autostart !== false && !entry.config.disabled) {
          work.push(conn.start().catch(() => undefined))
        }
      }
    }
    await Promise.all(work)
  }

  private createConnection(name: string, config: ServerConfig): ManagedConnection {
    const callbackUrl = `http://127.0.0.1:${this.opts.port}/oauth/callback`
    const conn: ManagedConnection = new ManagedConnection(
      name,
      config,
      {
        onChange: () => this.bump(),
        onInventoryChange: () => this.emitInventoryChange(),
      },
      config.kind === 'remote'
        ? new FileOAuthProvider(this.authStore, name, callbackUrl, {
            registry: this.pendingAuth,
            onAuthorizationUrl: (url) => {
              conn.authUrl = url
              this.bump()
            },
          })
        : null,
      this.opts.connection,
    )
    return conn
  }

  // --- config mutations ------------------------------------------------------------

  /** Shared write path: mutate the freshly-read doc, write atomically (409 on
   *  concurrent change), then hot-apply the result. */
  private async mutateConfig(mutate: (snap: ConfigSnapshot, doc: JsonObject) => ApiError | null): Promise<ApiResult> {
    const snap = this.store.read()
    if (snap.error !== null || snap.parsed === null) {
      return fail(409, `mcp.json has a problem; fix the file first: ${snap.error ?? 'unreadable'}`)
    }
    const doc = snap.parsed.doc
    const problem = mutate(snap, doc)
    if (problem) return problem
    const write = this.store.writeDoc(snap, doc)
    if (!write.ok) return fail(write.status ?? 500, write.error ?? 'write failed')
    await this.reload()
    return { ok: true }
  }

  addServer(name: unknown, input: unknown): Promise<ApiResult> {
    return this.mutateConfig((snap, doc) => {
      const nameCheck = validateServerName(name)
      if (!nameCheck.ok) return fail(400, nameCheck.error)
      const inputCheck = validateConfigInput(input)
      if (!inputCheck.ok) return fail(400, inputCheck.error)
      if (snap.parsed!.servers.has(name as string)) return fail(409, `server "${name as string}" already exists`)
      upsertServerInDoc(doc, name as string, inputCheck.value)
      return null
    })
  }

  updateServer(name: string, input: unknown): Promise<ApiResult> {
    return this.mutateConfig((snap, doc) => {
      if (!snap.parsed!.servers.has(name)) return fail(404, `unknown server "${name}"`)
      const inputCheck = validateConfigInput(input)
      if (!inputCheck.ok) return fail(400, inputCheck.error)
      upsertServerInDoc(doc, name, inputCheck.value)
      return null
    })
  }

  async deleteServer(name: string): Promise<ApiResult> {
    const result = await this.mutateConfig((_snap, doc) => {
      if (!removeServerFromDoc(doc, name)) return fail(404, `unknown server "${name}"`)
      return null
    })
    if (result.ok) this.authStore.remove(name)
    return result
  }

  setDisabled(name: string, disabled: boolean): Promise<ApiResult> {
    return this.mutateConfig((snap, doc) => {
      if (!snap.parsed!.servers.has(name)) return fail(404, `unknown server "${name}"`)
      if (!setDisabledInDoc(doc, name, disabled)) return fail(404, `unknown server "${name}"`)
      return null
    })
  }

  // --- lifecycle actions -------------------------------------------------------------

  private connectionOr404(name: string): ManagedConnection | ApiError {
    const conn = this.connections.get(name)
    if (!conn) return fail(404, `unknown server "${name}"`)
    return conn
  }

  async startServer(name: string): Promise<ApiResult> {
    const conn = this.connectionOr404(name)
    if (!(conn instanceof ManagedConnection)) return conn
    if (conn.config.disabled) return fail(409, `server "${name}" is disabled; enable it first`)
    await conn.start({ manual: true })
    this.bump()
    return { ok: true }
  }

  async stopServer(name: string): Promise<ApiResult> {
    const conn = this.connectionOr404(name)
    if (!(conn instanceof ManagedConnection)) return conn
    await conn.stop()
    this.bump()
    return { ok: true }
  }

  async restartServer(name: string): Promise<ApiResult> {
    const conn = this.connectionOr404(name)
    if (!(conn instanceof ManagedConnection)) return conn
    if (conn.config.disabled) return fail(409, `server "${name}" is disabled; enable it first`)
    await conn.restart()
    this.bump()
    return { ok: true }
  }

  // --- playground passthrough ----------------------------------------------------------

  private clientOr409(name: string): { client: NonNullable<ManagedConnection['activeClient']> } | ApiError {
    const conn = this.connections.get(name)
    if (!conn) return fail(404, `unknown server "${name}"`)
    const client = conn.activeClient
    if (!client) return fail(409, `server "${name}" is not running (status: ${conn.status})`)
    return { client }
  }

  async callTool(name: string, tool: string, args: Record<string, unknown>): Promise<ApiResult<{ result: unknown; durationMs: number }>> {
    const got = this.clientOr409(name)
    if ('ok' in got) return got
    const { client } = got
    const startedAt = Date.now()
    try {
      const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 120_000 })
      return { ok: true, result, durationMs: Date.now() - startedAt }
    } catch (err) {
      return fail(502, err instanceof Error ? err.message : String(err))
    }
  }

  async readResource(name: string, uri: string): Promise<ApiResult<{ result: unknown; durationMs: number }>> {
    const got = this.clientOr409(name)
    if ('ok' in got) return got
    const { client } = got
    const startedAt = Date.now()
    try {
      const result = await client.readResource({ uri }, { timeout: 60_000 })
      return { ok: true, result, durationMs: Date.now() - startedAt }
    } catch (err) {
      return fail(502, err instanceof Error ? err.message : String(err))
    }
  }

  async getPrompt(name: string, prompt: string, args: Record<string, string>): Promise<ApiResult<{ result: unknown; durationMs: number }>> {
    const got = this.clientOr409(name)
    if ('ok' in got) return got
    const { client } = got
    const startedAt = Date.now()
    try {
      const result = await client.getPrompt({ name: prompt, arguments: args }, { timeout: 60_000 })
      return { ok: true, result, durationMs: Date.now() - startedAt }
    } catch (err) {
      return fail(502, err instanceof Error ? err.message : String(err))
    }
  }

  // --- OAuth ------------------------------------------------------------------------

  /** Kick off (or re-surface) the authorization flow for a remote server. */
  async startAuth(name: string): Promise<ApiResult<{ authUrl: string | null }>> {
    const conn = this.connectionOr404(name)
    if (!(conn instanceof ManagedConnection)) return conn
    if (conn.config.kind !== 'remote') return fail(400, `server "${name}" is a stdio server; OAuth applies to remote servers`)
    if (conn.config.disabled) return fail(409, `server "${name}" is disabled; enable it first`)
    // (Re)connect; a 401 leg captures a fresh authorization URL via the provider.
    await conn.start({ manual: true })
    this.bump()
    return { ok: true, authUrl: conn.authUrl }
  }

  /** Handle GET /oauth/callback. Returns a user-facing message. */
  async completeAuth(state: string, code: string): Promise<ApiResult<{ server: string }>> {
    const server = this.pendingAuth.consume(state)
    if (!server) return fail(400, 'unknown or expired authorization state; restart the flow from the panel')
    const conn = this.connections.get(server)
    if (!conn) return fail(404, `server "${server}" no longer exists`)
    try {
      await conn.completeAuth(code)
    } catch (err) {
      return fail(502, `token exchange failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    this.bump()
    return { ok: true, server }
  }

  // --- aggregator + state ---------------------------------------------------------------

  /** Connections currently usable by the unified endpoint. */
  activeConnections(): ManagedConnection[] {
    return [...this.connections.values()].filter((c) => c.activeClient !== null)
  }

  getConnection(name: string): ManagedConnection | undefined {
    return this.connections.get(name)
  }

  getState(): StateSnapshot {
    const servers: ServerSnapshot[] = []
    const seen = new Set<string>()
    for (const [name, entry] of this.lastParsed?.servers ?? new Map()) {
      seen.add(name)
      const conn = this.connections.get(name)
      if (conn) {
        servers.push(conn.snapshot())
      } else {
        // Invalid entry: visible, actionable, but never launched.
        servers.push({
          name,
          transport: 'url' in entry.raw ? 'remote' : 'stdio',
          status: 'error',
          error: entry.error ?? 'invalid config entry',
          stderrTail: [],
          restartAttempt: 0,
          startedAt: null,
          handshake: null,
          tools: [],
          resources: [],
          prompts: [],
          authUrl: null,
          config: entry.raw as ServerConfigInput,
          configError: entry.error ?? 'invalid config entry',
        })
      }
    }
    servers.sort((a, b) => a.name.localeCompare(b.name))
    return {
      serial: this.serialCounter,
      configPath: this.store.file,
      initialized: this.initialized,
      configError: this.configError,
      servers,
      endpoint: {
        url: `http://127.0.0.1:${this.opts.port}/mcp`,
        authHeader: `Bearer ${this.opts.token}`,
      },
      workspaceRoot: this.opts.workspaceRoot || null,
    }
  }
}
