import { describe, expect, it, afterEach } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import { ManagedConnection, backoffDelayMs, type ConnectionEvents } from './connection'
import type { ServerConfig } from '../shared/types'

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../test/fixtures/echo-server.mjs')

const FAST = {
  pingIntervalMs: 200,
  pingTimeoutMs: 500,
  connectTimeoutMs: 10_000,
  backoffBaseMs: 50,
  backoffCapMs: 200,
  maxRestartAttempts: 3,
  stableAfterMs: 60_000,
}

function fixtureConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return { kind: 'stdio', command: process.execPath, args: [FIXTURE], env: {}, disabled: false, ...overrides } as ServerConfig
}

function events(): ConnectionEvents & { changes: number; invChanges: number } {
  const e = {
    changes: 0,
    invChanges: 0,
    onChange() {
      e.changes++
    },
    onInventoryChange() {
      e.invChanges++
    },
  }
  return e
}

async function waitFor(cond: () => boolean, timeoutMs = 10_000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

const live: ManagedConnection[] = []

function conn(config: ServerConfig, e = events()): ManagedConnection {
  const c = new ManagedConnection('fix', config, e, null, FAST)
  live.push(c)
  return c
}

afterEach(async () => {
  await Promise.all(live.splice(0).map((c) => c.stop().catch(() => undefined)))
})

describe('backoffDelayMs', () => {
  it('grows exponentially and caps', () => {
    expect(backoffDelayMs(1)).toBe(1000)
    expect(backoffDelayMs(2)).toBe(2000)
    expect(backoffDelayMs(3)).toBe(4000)
    expect(backoffDelayMs(6)).toBe(30_000)
    expect(backoffDelayMs(50)).toBe(30_000) // cap holds for absurd attempts
    expect(backoffDelayMs(2, 50, 200)).toBe(100)
  })
})

describe('ManagedConnection lifecycle (real stdio fixture)', () => {
  it('starts, completes the handshake, loads the inventory, then stops clean', async () => {
    const e = events()
    const c = conn(fixtureConfig(), e)
    await c.start({ manual: true })
    expect(c.status).toBe('running')
    expect(c.handshake?.name).toBe('echo-fixture')
    expect(c.handshake?.capabilities).toEqual(expect.arrayContaining(['tools', 'resources', 'prompts']))
    await waitFor(() => c.tools.length === 4, 10_000, 'tools inventory')
    expect(c.tools.map((t) => t.name)).toContain('echo')
    expect(c.resources.map((r) => r.uri)).toContain('fixture://greeting')
    expect(c.prompts.map((p) => p.name)).toContain('greet')
    // stderr tail captured from the child's startup line.
    await waitFor(() => c.stderrTail.length > 0, 5000, 'stderr tail')
    expect(c.stderrTail.join('\n')).toContain('echo-fixture starting')
    expect(e.invChanges).toBeGreaterThan(0)

    await c.stop()
    expect(c.status).toBe('stopped')
    expect(c.tools).toEqual([])
    expect(c.activeClient).toBeNull()
  })

  it('calls tools through the active client', async () => {
    const c = conn(fixtureConfig())
    await c.start({ manual: true })
    const result = (await c.activeClient!.callTool({ name: 'echo', arguments: { text: 'ping' } })) as {
      content: { type: string; text: string }[]
    }
    expect(result.content[0].text).toBe('ping')
  })

  it('a disabled config never starts', async () => {
    const c = conn(fixtureConfig({ disabled: true } as Partial<ServerConfig>))
    await c.start()
    expect(c.status).toBe('disabled')
    expect(c.activeClient).toBeNull()
  })

  it('missing ${env:VAR} fails fast with a clear error and no retry loop', async () => {
    const c = conn({ kind: 'stdio', command: '${env:CATE_MCP_TEST_DOES_NOT_EXIST}', args: [], env: {}, disabled: false })
    await c.start({ manual: true })
    expect(c.status).toBe('error')
    expect(c.error).toContain('CATE_MCP_TEST_DOES_NOT_EXIST')
    expect(c.restartAttempt).toBe(0)
  })

  it('a crash mid-run triggers supervised auto-restart back to running', async () => {
    const c = conn(fixtureConfig())
    await c.start({ manual: true })
    await waitFor(() => c.tools.length > 0, 10_000, 'inventory')
    // The `die` tool exits the child 50ms after responding: a real crash.
    await c.activeClient!.callTool({ name: 'die', arguments: {} })
    await waitFor(() => c.status === 'restarting' || c.restartAttempt > 0, 10_000, 'crash detection')
    await waitFor(() => c.status === 'running', 15_000, 'auto-restart recovery')
    expect(c.restartAttempt).toBeGreaterThan(0) // backoff counter not yet reset (stableAfterMs is long)
    expect(c.handshake?.name).toBe('echo-fixture')
  })

  it('a command that keeps dying backs off and eventually gives up with error', async () => {
    const c = conn({
      kind: 'stdio',
      command: process.execPath,
      args: ['-e', 'process.exit(3)'],
      env: {},
      disabled: false,
    })
    await c.start({ manual: true })
    await waitFor(() => c.status === 'error', 30_000, 'give-up after max restart attempts')
    expect(c.error).toContain('gave up after 3 restart attempts')
  })

  it('generation guard: a rapid restart is never clobbered by the old run\'s death', async () => {
    const c = conn(fixtureConfig())
    await c.start({ manual: true })
    const firstStartedAt = c.startedAt
    // Restart immediately: the old child dies while the new run is connecting.
    await c.restart()
    expect(c.status).toBe('running')
    expect(c.startedAt).not.toBe(firstStartedAt)
    // Give the old child's exit event time to fire; the state must not regress.
    await new Promise((r) => setTimeout(r, 500))
    expect(c.status).toBe('running')
    expect(c.restartAttempt).toBe(0)
  })

  it('stop during the restarting backoff cancels the pending retry', async () => {
    const c = conn({
      kind: 'stdio',
      command: process.execPath,
      args: ['-e', 'setTimeout(()=>process.exit(2), 300)'],
      env: {},
      disabled: false,
    })
    // This command speaks no MCP: connect fails, retry gets scheduled.
    await c.start({ manual: true })
    await waitFor(() => c.status === 'restarting' || c.status === 'error', 15_000, 'failure')
    await c.stop()
    expect(c.status).toBe('stopped')
    const after = c.restartAttempt
    await new Promise((r) => setTimeout(r, 400))
    expect(c.status).toBe('stopped') // no zombie retry brought it back
    expect(c.restartAttempt).toBe(after)
  })

  it('remote connect failure reports both transport attempts', async () => {
    const c = conn({ kind: 'remote', url: 'http://127.0.0.1:9/mcp', headers: {}, disabled: false })
    await c.start({ manual: true })
    await waitFor(() => c.status === 'error', 30_000, 'remote failure give-up')
    expect(c.error).toContain('streamable HTTP failed')
    expect(c.error).toContain('SSE fallback failed')
  })
})
