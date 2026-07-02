// =============================================================================
// One managed MCP server: connection lifecycle, supervision, inventory.
//
// Supervision uses a MONOTONIC GENERATION ID that
// guards every async step and child/connection event. Each (re)start bumps the
// generation; handlers capture their run's id and no-op when a newer run owns
// the state, so a replaced run's late exit/stderr/handshake can never clobber
// the run that superseded it. stdio children additionally get a SIGKILL
// escalation after close and a synchronous SIGKILL backstop on process exit.
//
// Statuses: stopped / starting / running / degraded / restarting / error /
// needs-auth / disabled (see shared/types.ts).
// =============================================================================

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import {
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { Readable } from 'stream'
import { expandConfig } from '../shared/config'
import type {
  PromptInfo,
  ResourceInfo,
  ServerConfig,
  ServerHandshakeInfo,
  ServerSnapshot,
  ServerStatus,
  ToolInfo,
} from '../shared/types'

const STDERR_TAIL_MAX = 100
const CLIENT_INFO = { name: 'cate-mcp', version: '1.0.0' }

// --- child pid backstop --------------------------------------------------------

/** Live stdio child pids. 'exit' runs synchronously and timers never fire after
 *  it, so the backstop SIGKILLs directly (no graceful escalation possible). */
const livePids = new Set<number>()
let backstopInstalled = false

function installExitBackstop(): void {
  if (backstopInstalled) return
  backstopInstalled = true
  process.on('exit', () => {
    for (const pid of livePids) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
  })
}

/** After a graceful close, make sure the child is really gone: SIGKILL in 3s
 *  unless it already exited (the SDK's own close does stdin-end -> SIGTERM). */
function escalateKill(pid: number | null): void {
  if (pid === null) return
  setTimeout(() => {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
    livePids.delete(pid)
  }, 3000).unref()
}

// --- helpers -------------------------------------------------------------------

/** Exponential backoff delay for restart attempt n (1-based), capped. */
export function backoffDelayMs(attempt: number, baseMs = 1000, capMs = 30_000): number {
  const exp = Math.min(attempt - 1, 30) // avoid overflow for absurd attempts
  return Math.min(capMs, baseMs * 2 ** exp)
}

export const MAX_RESTART_ATTEMPTS = 8

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    timer.unref?.()
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isUnauthorized(err: unknown): boolean {
  if (err instanceof UnauthorizedError) return true
  const text = errText(err)
  return /\b401\b/.test(text) || /unauthorized/i.test(text)
}

export interface ConnectionEvents {
  /** Any observable state changed (status, error, inventory, ...). */
  onChange(): void
  /** Tool/resource/prompt inventory changed (aggregator emits listChanged). */
  onInventoryChange(): void
}

export interface ConnectionOptions {
  pingIntervalMs?: number
  pingTimeoutMs?: number
  connectTimeoutMs?: number
  backoffBaseMs?: number
  backoffCapMs?: number
  /** Give up auto-restarting after this many consecutive failed runs. */
  maxRestartAttempts?: number
  /** A run alive this long resets the backoff counter. */
  stableAfterMs?: number
}

export class ManagedConnection {
  readonly name: string
  config: ServerConfig
  /** Per-entry config problem reported by the manager (invalid entries never
   *  get a connection, so this stays null here; kept for snapshot symmetry). */
  configError: string | null = null

  status: ServerStatus = 'stopped'
  error: string | null = null
  stderrTail: string[] = []
  restartAttempt = 0
  startedAt: number | null = null
  handshake: ServerHandshakeInfo | null = null
  tools: ToolInfo[] = []
  resources: ResourceInfo[] = []
  prompts: PromptInfo[] = []
  authUrl: string | null = null

  /** Monotonic run id guarding async steps against a superseded run. */
  private generation = 0
  private desired: 'stopped' | 'running' = 'stopped'
  private client: Client | null = null
  private childPid: number | null = null
  private pingTimer: NodeJS.Timeout | null = null
  private restartTimer: NodeJS.Timeout | null = null
  private stableTimer: NodeJS.Timeout | null = null
  private pingInFlight = false

  private readonly events: ConnectionEvents
  private readonly opts: Required<ConnectionOptions>
  readonly authProvider: OAuthClientProvider | null

  constructor(
    name: string,
    config: ServerConfig,
    events: ConnectionEvents,
    authProvider: OAuthClientProvider | null,
    options: ConnectionOptions = {},
  ) {
    this.name = name
    this.config = config
    this.events = events
    this.authProvider = authProvider
    this.opts = {
      pingIntervalMs: options.pingIntervalMs ?? 15_000,
      pingTimeoutMs: options.pingTimeoutMs ?? 5_000,
      connectTimeoutMs: options.connectTimeoutMs ?? 30_000,
      backoffBaseMs: options.backoffBaseMs ?? 1_000,
      backoffCapMs: options.backoffCapMs ?? 30_000,
      maxRestartAttempts: options.maxRestartAttempts ?? MAX_RESTART_ATTEMPTS,
      stableAfterMs: options.stableAfterMs ?? 30_000,
    }
    installExitBackstop()
    if (config.disabled) this.status = 'disabled'
  }

  /** The live SDK client while running/degraded (playground + aggregator use it). */
  get activeClient(): Client | null {
    return this.status === 'running' || this.status === 'degraded' ? this.client : null
  }

  get transportKind(): 'stdio' | 'remote' {
    return this.config.kind === 'stdio' ? 'stdio' : 'remote'
  }

  /** Called by the manager when a config edit changed this server's entry.
   *  The manager decides whether to restart; this just swaps the config. */
  setConfig(config: ServerConfig): void {
    this.config = config
  }

  // --- lifecycle ---------------------------------------------------------------

  async start(opts: { manual?: boolean } = {}): Promise<void> {
    if (this.config.disabled) {
      this.status = 'disabled'
      this.events.onChange()
      return
    }
    this.desired = 'running'
    if (opts.manual) this.restartAttempt = 0
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    await this.connect()
  }

  async stop(): Promise<void> {
    this.desired = 'stopped'
    this.teardownRun()
    this.status = this.config.disabled ? 'disabled' : 'stopped'
    this.error = null
    this.authUrl = null
    this.events.onChange()
    this.events.onInventoryChange()
  }

  async restart(): Promise<void> {
    await this.stop()
    await this.start({ manual: true })
  }

  /** Full teardown for delete: like stop, but also clears listeners. */
  async dispose(): Promise<void> {
    await this.stop()
  }

  /** Finish an OAuth code exchange, then reconnect with the new tokens. */
  async completeAuth(code: string): Promise<void> {
    if (this.config.kind !== 'stdio') {
      const expanded = expandConfig(this.config, process.env)
      if (!expanded.ok) throw new Error(expanded.error)
      if (expanded.config.kind !== 'remote') throw new Error('unreachable')
      if (!this.authProvider) throw new Error('no auth provider for this server')
      // A fresh transport works for finishAuth: the code verifier and client
      // information were persisted by the provider during the redirect leg.
      const transport = new StreamableHTTPClientTransport(new URL(expanded.config.url), {
        authProvider: this.authProvider,
      })
      await transport.finishAuth(code)
      await transport.close().catch(() => undefined)
    }
    await this.restart()
  }

  // --- connect machinery --------------------------------------------------------

  private async connect(): Promise<void> {
    const gen = ++this.generation
    this.closeClientArtifacts()
    this.status = this.restartAttempt > 0 ? 'restarting' : 'starting'
    this.error = null
    this.authUrl = null
    this.stderrTail = [] // this run's log, not the previous failure's
    this.handshake = null
    this.events.onChange()

    const expanded = expandConfig(this.config, process.env)
    if (!expanded.ok) {
      this.enterError(gen, expanded.error, { retry: false })
      return
    }

    try {
      if (expanded.config.kind === 'stdio') {
        await this.connectStdio(gen, expanded.config.command, expanded.config.args, expanded.config.env, expanded.config.cwd)
      } else {
        await this.connectRemote(gen, expanded.config.url, expanded.config.headers)
      }
    } catch (err) {
      if (gen !== this.generation) return // superseded mid-connect; new run owns state
      if (isUnauthorized(err)) {
        // authUrl was captured via the provider's redirect hook (if any).
        this.status = 'needs-auth'
        this.error = 'authorization required'
        this.events.onChange()
        return
      }
      this.enterError(gen, errText(err), { retry: true })
    }
  }

  private async connectStdio(
    gen: number,
    command: string,
    args: string[],
    env: Record<string, string>,
    cwd: string | undefined,
  ): Promise<void> {
    const transport = new StdioClientTransport({
      command,
      args,
      env: { ...getDefaultEnvironment(), ...env },
      cwd,
      stderr: 'pipe',
    })
    // The PassThrough exists before start(), so no early output is lost.
    const stderr = transport.stderr as Readable | null
    stderr?.on('data', (chunk: Buffer) => {
      if (gen !== this.generation) return
      this.recordStderr(chunk.toString('utf8'))
    })
    const client = new Client(CLIENT_INFO)
    try {
      await withTimeout(
        client.connect(transport),
        this.opts.connectTimeoutMs,
        `server did not complete the MCP handshake within ${Math.round(this.opts.connectTimeoutMs / 1000)}s`,
      )
    } catch (err) {
      // Reap the child on handshake failure/timeout so a retry can't stack a
      // second process on top of a stuck one.
      const pid = transport.pid
      await client.close().catch(() => undefined)
      escalateKill(pid)
      throw err
    }
    if (transport.pid !== null) livePids.add(transport.pid)
    this.adoptClient(gen, client, transport.pid)
  }

  private async connectRemote(gen: number, url: string, headers: Record<string, string>): Promise<void> {
    const target = new URL(url)
    const authProvider = this.authProvider ?? undefined
    // Streamable HTTP first; SSE is the compatibility fallback for older
    // servers. Auth failures surface immediately (no point falling back).
    try {
      const transport = new StreamableHTTPClientTransport(target, {
        authProvider,
        requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
      })
      const client = new Client(CLIENT_INFO)
      await withTimeout(client.connect(transport), this.opts.connectTimeoutMs, 'connect timed out (streamable HTTP)')
      this.adoptClient(gen, client, null)
      return
    } catch (streamableErr) {
      if (gen !== this.generation) return
      if (isUnauthorized(streamableErr)) throw streamableErr
      try {
        const injectHeaders: typeof fetch = (input, init) =>
          fetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), ...headers } })
        const transport = new SSEClientTransport(target, {
          authProvider,
          fetch: Object.keys(headers).length > 0 ? injectHeaders : undefined,
        })
        const client = new Client(CLIENT_INFO)
        await withTimeout(client.connect(transport), this.opts.connectTimeoutMs, 'connect timed out (SSE)')
        this.adoptClient(gen, client, null)
        return
      } catch (sseErr) {
        if (isUnauthorized(sseErr)) throw sseErr
        throw new Error(`streamable HTTP failed: ${errText(streamableErr)}; SSE fallback failed: ${errText(sseErr)}`)
      }
    }
  }

  /** Handshake done: wire handlers, capture server info, load inventory. */
  private adoptClient(gen: number, client: Client, pid: number | null): void {
    if (gen !== this.generation) {
      // Superseded while connecting: this run's client must not leak.
      void client.close().catch(() => undefined)
      escalateKill(pid)
      return
    }
    this.client = client
    this.childPid = pid
    const impl = client.getServerVersion()
    const caps = client.getServerCapabilities() ?? {}
    this.handshake = {
      name: typeof impl?.name === 'string' ? impl.name : '(unknown)',
      version: typeof impl?.version === 'string' ? impl.version : '',
      capabilities: Object.keys(caps).sort(),
      instructions: client.getInstructions(),
    }
    client.onclose = () => this.handleClosed(gen)
    client.onerror = (err) => {
      if (gen !== this.generation) return
      // Record but don't transition; a fatal error is followed by onclose.
      if (this.status === 'running' || this.status === 'degraded') this.error = errText(err)
    }
    if (caps.tools?.listChanged) {
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        await this.refreshInventory(gen, 'tools')
        this.events.onInventoryChange()
      })
    }
    if (caps.resources?.listChanged) {
      client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
        await this.refreshInventory(gen, 'resources')
        this.events.onInventoryChange()
      })
    }
    if (caps.prompts?.listChanged) {
      client.setNotificationHandler(PromptListChangedNotificationSchema, async () => {
        await this.refreshInventory(gen, 'prompts')
        this.events.onInventoryChange()
      })
    }
    this.status = 'running'
    this.error = null
    this.startedAt = Date.now()
    this.startPingLoop(gen)
    // A run that survives long enough proves the config works again.
    this.stableTimer = setTimeout(() => {
      if (gen === this.generation) this.restartAttempt = 0
    }, this.opts.stableAfterMs)
    this.stableTimer.unref?.()
    this.events.onChange()
    void this.refreshInventory(gen, 'all').then(() => {
      if (gen === this.generation) this.events.onInventoryChange()
    })
  }

  private handleClosed(gen: number): void {
    if (gen !== this.generation) return // a replaced run closing is expected
    const lastStderr = this.stderrTail[this.stderrTail.length - 1]
    this.closeClientArtifacts()
    this.clearInventory()
    if (this.desired === 'stopped') {
      this.status = this.config.disabled ? 'disabled' : 'stopped'
      this.events.onChange()
      this.events.onInventoryChange()
      return
    }
    const detail = this.error ?? (lastStderr ? `connection closed (last stderr: ${lastStderr})` : 'connection closed unexpectedly')
    this.scheduleRestart(detail)
    this.events.onInventoryChange()
  }

  private enterError(gen: number, message: string, opts: { retry: boolean }): void {
    if (gen !== this.generation) return
    this.closeClientArtifacts()
    this.clearInventory()
    if (opts.retry && this.desired === 'running') {
      this.scheduleRestart(message)
    } else {
      this.status = 'error'
      this.error = message
      this.events.onChange()
    }
    this.events.onInventoryChange()
  }

  private scheduleRestart(reason: string): void {
    this.restartAttempt += 1
    this.error = reason
    if (this.restartAttempt > this.opts.maxRestartAttempts) {
      this.status = 'error'
      this.error = `${reason} (gave up after ${this.opts.maxRestartAttempts} restart attempts; use Restart to try again)`
      this.restartAttempt = 0
      this.events.onChange()
      return
    }
    this.status = 'restarting'
    this.events.onChange()
    const delay = backoffDelayMs(this.restartAttempt, this.opts.backoffBaseMs, this.opts.backoffCapMs)
    const gen = this.generation
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      // Only this run may fire its retry; stop()/restart() bump the generation.
      if (gen !== this.generation || this.desired !== 'running') return
      void this.connect()
    }, delay)
    this.restartTimer.unref?.()
  }

  // --- health ------------------------------------------------------------------

  private startPingLoop(gen: number): void {
    this.pingTimer = setInterval(() => {
      if (gen !== this.generation || this.pingInFlight) return
      const client = this.client
      if (!client || (this.status !== 'running' && this.status !== 'degraded')) return
      this.pingInFlight = true
      client
        .ping({ timeout: this.opts.pingTimeoutMs })
        .then(() => {
          if (gen !== this.generation) return
          if (this.status === 'degraded') {
            this.status = 'running'
            this.error = null
            this.events.onChange()
          }
        })
        .catch((err) => {
          if (gen !== this.generation) return
          if (this.status === 'running') {
            this.status = 'degraded'
            this.error = `ping failed: ${errText(err)}`
            this.events.onChange()
          }
        })
        .finally(() => {
          this.pingInFlight = false
        })
    }, this.opts.pingIntervalMs)
    this.pingTimer.unref?.()
  }

  // --- inventory -----------------------------------------------------------------

  private async refreshInventory(gen: number, which: 'tools' | 'resources' | 'prompts' | 'all'): Promise<void> {
    const client = this.client
    if (!client || gen !== this.generation) return
    const caps = client.getServerCapabilities() ?? {}
    // Only ask for what the server advertised; calling an unsupported list is a
    // protocol error on strict servers.
    if ((which === 'tools' || which === 'all') && caps.tools) {
      try {
        const tools: ToolInfo[] = []
        let cursor: string | undefined
        do {
          const page = await client.listTools(cursor ? { cursor } : {})
          for (const t of page.tools) {
            tools.push({ name: t.name, description: t.description, inputSchema: t.inputSchema })
          }
          cursor = page.nextCursor
        } while (cursor)
        if (gen === this.generation) this.tools = tools
      } catch {
        /* keep the previous list; a transient failure isn't an empty server */
      }
    }
    if ((which === 'resources' || which === 'all') && caps.resources) {
      try {
        const resources: ResourceInfo[] = []
        let cursor: string | undefined
        do {
          const page = await client.listResources(cursor ? { cursor } : {})
          for (const r of page.resources) {
            resources.push({ uri: r.uri, name: r.name, description: r.description, mimeType: r.mimeType })
          }
          cursor = page.nextCursor
        } while (cursor)
        if (gen === this.generation) this.resources = resources
      } catch {
        /* keep previous */
      }
    }
    if ((which === 'prompts' || which === 'all') && caps.prompts) {
      try {
        const prompts: PromptInfo[] = []
        let cursor: string | undefined
        do {
          const page = await client.listPrompts(cursor ? { cursor } : {})
          for (const p of page.prompts) {
            prompts.push({
              name: p.name,
              description: p.description,
              arguments: p.arguments?.map((a) => ({ name: a.name, description: a.description, required: a.required })),
            })
          }
          cursor = page.nextCursor
        } while (cursor)
        if (gen === this.generation) this.prompts = prompts
      } catch {
        /* keep previous */
      }
    }
    if (gen === this.generation) this.events.onChange()
  }

  private clearInventory(): void {
    this.tools = []
    this.resources = []
    this.prompts = []
    this.handshake = null
    this.startedAt = null
  }

  // --- plumbing ------------------------------------------------------------------

  private recordStderr(text: string): void {
    for (const part of text.split(/\r?\n/)) {
      const trimmed = part.trimEnd()
      if (!trimmed) continue
      this.stderrTail.push(trimmed)
      if (this.stderrTail.length > STDERR_TAIL_MAX) this.stderrTail.shift()
    }
    this.events.onChange()
  }

  /** Orphan the current run: bump generation, stop timers, close the client
   *  (which kills a stdio child), escalate to SIGKILL if it lingers. */
  private teardownRun(): void {
    this.generation++
    this.closeClientArtifacts()
    this.clearInventory()
  }

  private closeClientArtifacts(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    if (this.stableTimer) {
      clearTimeout(this.stableTimer)
      this.stableTimer = null
    }
    const client = this.client
    const pid = this.childPid
    this.client = null
    this.childPid = null
    if (client) {
      client.onclose = undefined
      void client.close().catch(() => undefined)
    }
    escalateKill(pid)
  }

  // --- snapshot ------------------------------------------------------------------

  snapshot(): ServerSnapshot {
    const cfg = this.config
    return {
      name: this.name,
      transport: this.transportKind,
      status: this.status,
      error: this.error,
      stderrTail: this.stderrTail.slice(-12),
      restartAttempt: this.restartAttempt,
      startedAt: this.startedAt,
      handshake: this.handshake,
      tools: this.tools,
      resources: this.resources,
      prompts: this.prompts,
      authUrl: this.authUrl,
      config:
        cfg.kind === 'stdio'
          ? { command: cfg.command, args: cfg.args, env: cfg.env, cwd: cfg.cwd, disabled: cfg.disabled }
          : { url: cfg.url, headers: cfg.headers, disabled: cfg.disabled },
      configError: this.configError,
    }
  }
}
