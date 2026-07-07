// End-to-end API tests: the production request handler mounted on an
// ephemeral loopback port, driven with real fetch. Covers the validation
// matrix (400/401/404/409), state-serial gating, unknown-field preservation
// through API writes, watcher hot-apply, the playground passthrough against
// the real stdio fixture, and the unified /mcp endpoint over real HTTP.

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Manager } from './manager'
import { Aggregator } from './aggregate'
import { ActivityLog } from './activity'
import { AgentInstaller } from './agent-install'
import { createRequestHandler } from './http-app'
import type { RegistryResult } from './registry-client'
import type { StateSnapshot } from '../shared/types'

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../test/fixtures/echo-server.mjs')
const TOKEN = 'test-token'

interface TestApp {
  tmp: string
  port: number
  manager: Manager
  close(): Promise<void>
}

let app: TestApp
let registryStub: () => RegistryResult

async function boot(autostart = false): Promise<TestApp> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-mcp-api-'))
  const manager = new Manager({
    workspaceRoot: tmp,
    port: 0, // patched below once the listener knows its port
    token: TOKEN,
    autostart,
    connection: { pingIntervalMs: 60_000, backoffBaseMs: 50, backoffCapMs: 100, maxRestartAttempts: 2 },
  })
  const aggregator = new Aggregator(manager, new ActivityLog())
  manager.onInventoryChange(() => aggregator.notifyListsChanged())
  const handler = createRequestHandler({
    manager,
    aggregator,
    registry: { search: async () => registryStub() },
    installer: new AgentInstaller(tmp),
    token: TOKEN,
    publicDir: path.join(tmp, 'no-public'),
  })
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await manager.init()
  return {
    tmp,
    port,
    manager,
    close: async () => {
      await aggregator.close()
      await manager.shutdown()
      await new Promise((resolve) => server.close(resolve))
      fs.rmSync(tmp, { recursive: true, force: true })
    },
  }
}

function api(pathname: string, init: RequestInit = {}, token: string | null = TOKEN): Promise<Response> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) }
  if (token) headers.Authorization = `Bearer ${token}`
  if (init.body) headers['Content-Type'] = 'application/json'
  return fetch(`http://127.0.0.1:${app.port}${pathname}`, { ...init, headers })
}

async function getState(): Promise<StateSnapshot> {
  const res = await api('/api/state')
  const body = (await res.json()) as { state: StateSnapshot }
  return body.state
}

async function waitFor(cond: () => Promise<boolean> | boolean, timeoutMs = 15_000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

beforeEach(async () => {
  registryStub = () => ({ ok: true, entries: [], nextCursor: null })
  app = await boot()
})

afterEach(async () => {
  await app.close()
})

describe('auth', () => {
  it('health is auth-exempt; the API is not', async () => {
    expect((await api('/health', {}, null)).status).toBe(200)
    expect((await api('/api/state', {}, null)).status).toBe(401)
    expect((await api('/api/state', {}, 'wrong')).status).toBe(401)
    expect((await api('/mcp', { method: 'POST', body: '{}' }, null)).status).toBe(401)
  })
})

describe('validation matrix', () => {
  it('rejects malformed bodies and invalid names/configs with 400', async () => {
    expect((await api('/api/servers', { method: 'POST', body: 'not json' })).status).toBe(400)
    const cases = [
      { name: 'bad__name', config: { command: 'x' } },
      { name: 'ok', config: { command: 'x', url: 'y' } },
      { name: 'ok', config: {} },
      { name: '', config: { command: 'x' } },
      { name: 'ok', config: { command: 'x', args: 'not-array' } },
    ]
    for (const body of cases) {
      const res = await api('/api/servers', { method: 'POST', body: JSON.stringify(body) })
      expect(res.status).toBe(400)
    }
  })

  it('404s unknown servers on update/delete/actions/playground', async () => {
    expect((await api('/api/servers/ghost', { method: 'PATCH', body: JSON.stringify({ config: { command: 'x' } }) })).status).toBe(404)
    expect((await api('/api/servers/ghost', { method: 'DELETE' })).status).toBe(404)
    expect((await api('/api/servers/ghost/start', { method: 'POST', body: '{}' })).status).toBe(404)
    expect((await api('/api/tools/call', { method: 'POST', body: JSON.stringify({ server: 'ghost', tool: 't' }) })).status).toBe(404)
    expect((await api('/api/unknown-route')).status).toBe(404)
  })

  it('409s duplicate adds, disabled starts, and not-running playground calls', async () => {
    const add = await api('/api/servers', {
      method: 'POST',
      body: JSON.stringify({ name: 'fix', config: { command: 'x', disabled: true } }),
    })
    expect(add.status).toBe(200)
    const dup = await api('/api/servers', { method: 'POST', body: JSON.stringify({ name: 'fix', config: { command: 'y' } }) })
    expect(dup.status).toBe(409)
    expect((await api('/api/servers/fix/start', { method: 'POST', body: '{}' })).status).toBe(409)
    // Enable (still autostart=false at boot, and enable does not force-start
    // an already-loaded config; the entry is stopped, so playground 409s).
    expect((await api('/api/servers/fix/enable', { method: 'POST', body: '{}' })).status).toBe(200)
    const call = await api('/api/tools/call', { method: 'POST', body: JSON.stringify({ server: 'fix', tool: 'echo' }) })
    expect(call.status).toBe(409)
  })

  it('oauth/start on a stdio server is a 400', async () => {
    await api('/api/servers', { method: 'POST', body: JSON.stringify({ name: 'fix', config: { command: 'x', disabled: true } }) })
    const res = await api('/api/oauth/start', { method: 'POST', body: JSON.stringify({ server: 'fix' }) })
    expect(res.status).toBe(400)
  })

  it('oauth callback with an unknown state is a 400 page', async () => {
    const res = await fetch(`http://127.0.0.1:${app.port}/oauth/callback?state=bogus&code=abc`)
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('Authorization failed')
  })
})

describe('state serial gating', () => {
  it('answers unchanged for a known serial and full state after a change', async () => {
    const first = (await (await api('/api/state')).json()) as { serial: number; state?: StateSnapshot }
    expect(first.state).toBeDefined()
    const again = (await (await api(`/api/state?known=${first.serial}`)).json()) as { unchanged?: boolean }
    expect(again.unchanged).toBe(true)
    await api('/api/servers', { method: 'POST', body: JSON.stringify({ name: 'n', config: { command: 'x', disabled: true } }) })
    const later = (await (await api(`/api/state?known=${first.serial}`)).json()) as { serial: number; state?: StateSnapshot }
    expect(later.serial).toBeGreaterThan(first.serial)
    expect(later.state?.servers.map((s) => s.name)).toContain('n')
  })
})

describe('config writes through the API', () => {
  it('preserves unknown fields and keys on update, and expands nothing', async () => {
    const file = path.join(app.tmp, '.cate', 'mcp.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          $schema: 'https://example.com/custom.json',
          mcpServers: { keep: { command: 'run', vendorExtra: { a: 1 }, env: { T: '${env:SOME_TOKEN}' }, disabled: true } },
          somethingElse: 'stays',
        },
        null,
        2,
      ),
    )
    await waitFor(async () => (await getState()).servers.some((s) => s.name === 'keep'), 10_000, 'watcher pickup')
    const res = await api('/api/servers/keep', {
      method: 'PATCH',
      body: JSON.stringify({ config: { command: 'run2', env: { T: '${env:SOME_TOKEN}' }, disabled: true } }),
    })
    expect(res.status).toBe(200)
    const round = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(round.$schema).toBe('https://example.com/custom.json')
    expect(round.somethingElse).toBe('stays')
    expect(round.mcpServers.keep.vendorExtra).toEqual({ a: 1 })
    expect(round.mcpServers.keep.command).toBe('run2')
    // Placeholder written back verbatim, never expanded into the file.
    expect(round.mcpServers.keep.env.T).toBe('${env:SOME_TOKEN}')
  })

  it('delete removes the entry and its stored auth', async () => {
    await api('/api/servers', { method: 'POST', body: JSON.stringify({ name: 'gone', config: { url: 'https://x.test/mcp', disabled: true } }) })
    app.manager.authStore.patch('gone', { codeVerifier: 'v' })
    expect((await api('/api/servers/gone', { method: 'DELETE' })).status).toBe(200)
    expect(app.manager.authStore.get('gone')).toEqual({})
    expect((await getState()).servers.map((s) => s.name)).not.toContain('gone')
  })

  it('a corrupt config file turns mutations into 409 and surfaces configError', async () => {
    const file = path.join(app.tmp, '.cate', 'mcp.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{ corrupt!!')
    await waitFor(async () => (await getState()).configError !== null, 10_000, 'config error surfaced')
    const res = await api('/api/servers', { method: 'POST', body: JSON.stringify({ name: 'x', config: { command: 'c' } }) })
    expect(res.status).toBe(409)
    // Recovery: fix the file, the watcher clears the error.
    fs.writeFileSync(file, '{"mcpServers": {}}')
    await waitFor(async () => (await getState()).configError === null, 10_000, 'config recovery')
  })
})

describe('watcher hot-apply of external edits', () => {
  it('applies added/changed/removed entries from a hand edit', async () => {
    const file = path.join(app.tmp, '.cate', 'mcp.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { a: { command: 'x', disabled: true }, b: { command: 'y', disabled: true } } }))
    await waitFor(async () => (await getState()).servers.length === 2, 10_000, 'external add')
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { a: { command: 'x2', disabled: true }, c: { url: 'https://x.test/mcp', disabled: true } } }))
    await waitFor(async () => {
      const s = await getState()
      const names = s.servers.map((x) => x.name).sort()
      return names.join(',') === 'a,c' && s.servers.find((x) => x.name === 'a')?.config.command === 'x2'
    }, 10_000, 'external change/remove')
  })

  it('invalid entries surface per-server errors without breaking valid ones', async () => {
    const file = path.join(app.tmp, '.cate', 'mcp.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { good: { command: 'x', disabled: true }, bad: { nope: 1 } } }))
    await waitFor(async () => (await getState()).servers.length === 2, 10_000, 'entries visible')
    const state = await getState()
    const bad = state.servers.find((s) => s.name === 'bad')
    expect(bad?.status).toBe('error')
    expect(bad?.configError).toBeTruthy()
    expect(state.servers.find((s) => s.name === 'good')?.status).toBe('disabled')
  })
})

describe('registry endpoint', () => {
  it('passes results through and maps failures to 502 inside the tab', async () => {
    registryStub = () => ({
      ok: true,
      entries: [
        { name: 'x/y', title: 'Y', description: 'd', version: '1', publisher: 'x', packages: [], remotes: [] },
      ],
      nextCursor: 'next',
    })
    const ok = (await (await api('/api/registry/search?q=y')).json()) as { ok: boolean; entries: { name: string }[]; nextCursor: string }
    expect(ok.ok).toBe(true)
    expect(ok.entries[0].name).toBe('x/y')
    expect(ok.nextCursor).toBe('next')
    registryStub = () => ({ ok: false, error: 'offline' })
    const res = await api('/api/registry/search?q=y')
    expect(res.status).toBe(502)
    expect(((await res.json()) as { error: string }).error).toBe('offline')
  })
})

describe('agent install endpoints', () => {
  it('lists agents, installs the endpoint, then uninstalls it', async () => {
    const listed = (await (await api('/api/agents')).json()) as {
      ok: boolean
      agents: { id: string; installed: boolean }[]
    }
    expect(listed.ok).toBe(true)
    expect(listed.agents.find((a) => a.id === 'claude-code')?.installed).toBe(false)

    const ins = await api('/api/agents/install', { method: 'POST', body: JSON.stringify({ id: 'claude-code' }) })
    expect(ins.status).toBe(200)
    const doc = JSON.parse(fs.readFileSync(path.join(app.tmp, '.mcp.json'), 'utf8'))
    expect(doc.mcpServers.cate.url).toBe(app.manager.getState().endpoint.url)
    expect(doc.mcpServers.cate.headers.Authorization).toBe(`Bearer ${TOKEN}`)

    const after = (await (await api('/api/agents')).json()) as { agents: { id: string; installed: boolean }[] }
    expect(after.agents.find((a) => a.id === 'claude-code')?.installed).toBe(true)

    const del = await api('/api/agents/uninstall', { method: 'POST', body: JSON.stringify({ id: 'claude-code' }) })
    expect(del.status).toBe(200)
    expect(JSON.parse(fs.readFileSync(path.join(app.tmp, '.mcp.json'), 'utf8')).mcpServers.cate).toBeUndefined()
  })

  it('rejects an unsupported agent and a missing id', async () => {
    const anti = await api('/api/agents/install', { method: 'POST', body: JSON.stringify({ id: 'pi' }) })
    expect(anti.status).toBe(400)
    const bad = await api('/api/agents/install', { method: 'POST', body: JSON.stringify({}) })
    expect(bad.status).toBe(400)
  })
})

describe('live fixture end to end', () => {
  it('add + start a real stdio server, call a tool, then reach it through /mcp', async () => {
    const add = await api('/api/servers', {
      method: 'POST',
      body: JSON.stringify({ name: 'fix', config: { command: process.execPath, args: [FIXTURE] } }),
    })
    expect(add.status).toBe(200)
    expect((await api('/api/servers/fix/start', { method: 'POST', body: '{}' })).status).toBe(200)
    await waitFor(async () => {
      const s = await getState()
      const fix = s.servers.find((x) => x.name === 'fix')
      return fix?.status === 'running' && fix.tools.length === 4
    }, 20_000, 'fixture running with inventory')

    // Playground passthrough.
    const call = (await (
      await api('/api/tools/call', { method: 'POST', body: JSON.stringify({ server: 'fix', tool: 'echo', args: { text: 'ping' } }) })
    ).json()) as { ok: boolean; content: { type: string; text: string }[]; durationMs: number }
    expect(call.ok).toBe(true)
    expect(call.content[0].text).toBe('ping')
    expect(call.durationMs).toBeGreaterThanOrEqual(0)

    const read = (await (
      await api('/api/resources/read', { method: 'POST', body: JSON.stringify({ server: 'fix', uri: 'fixture://greeting' }) })
    ).json()) as { ok: boolean; contents: { text: string }[] }
    expect(read.contents[0].text).toBe('hello from fixture')

    const prompt = (await (
      await api('/api/prompts/get', { method: 'POST', body: JSON.stringify({ server: 'fix', prompt: 'greet', args: { name: 'Ada' } }) })
    ).json()) as { ok: boolean; messages: { role: string; content: { text?: string } }[] }
    expect(prompt.messages[0].content.text).toContain('Ada')

    // The unified endpoint over real HTTP with the bearer token.
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${app.port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    })
    const client = new Client({ name: 'external-agent', version: '1.0' })
    await client.connect(transport)
    try {
      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name)).toContain('fix__echo')
      const result = (await client.callTool({ name: 'fix__echo', arguments: { text: 'through the endpoint' } })) as {
        content: { text: string }[]
      }
      expect(result.content[0].text).toBe('through the endpoint')
      // Upstream tool error comes back as a tool error through the endpoint too.
      const failed = (await client.callTool({ name: 'fix__fail', arguments: {} })) as { isError?: boolean }
      expect(failed.isError).toBe(true)
    } finally {
      await client.close()
    }

    // The recorder logged both calls through the aggregator: right server/tool,
    // the isError flag, and the connecting client's advertised name.
    const activity = (await (await api('/api/activity')).json()) as {
      ok: boolean
      entries: { server: string; tool: string; isError: boolean; client?: string }[]
      summary: { total: number; errors: number }
    }
    expect(activity.ok).toBe(true)
    const echo = activity.entries.find((e) => e.server === 'fix' && e.tool === 'echo' && !e.isError)
    expect(echo).toBeTruthy()
    expect(echo?.client).toBe('external-agent')
    const failedEntry = activity.entries.find((e) => e.server === 'fix' && e.tool === 'fail')
    expect(failedEntry?.isError).toBe(true)
    expect(activity.summary.total).toBeGreaterThanOrEqual(2)
    expect(activity.summary.errors).toBeGreaterThanOrEqual(1)

    // Stop: the endpoint no longer lists it.
    expect((await api('/api/servers/fix/stop', { method: 'POST', body: '{}' })).status).toBe(200)
    await waitFor(async () => (await getState()).servers.find((s) => s.name === 'fix')?.status === 'stopped', 10_000, 'stopped')
  }, 40_000)
})
