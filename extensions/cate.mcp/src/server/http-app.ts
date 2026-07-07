// =============================================================================
// HTTP routing for the extension server. Kept separate from the entry point so
// the API tests can mount the exact production handler on an ephemeral port.
//
// Routes (bearer CATE_TOKEN required unless marked):
//   GET  /health                        readiness probe (auth-exempt)
//   GET  /oauth/callback                OAuth redirect URI (auth-exempt; the
//                                       browser carries no bearer; guarded by
//                                       the single-use `state` parameter)
//   GET  /                              panel HTML + static assets
//   GET  /api/state?known=<serial>      config + runtime status + inventories
//   GET  /api/activity?limit=<n>        recent tool calls through /mcp + summary
//   POST /api/servers                   add server        { name, config }
//   PATCH  /api/servers/:name           update server     { config }
//   DELETE /api/servers/:name           delete server
//   POST /api/servers/:name/start|stop|restart|enable|disable
//   POST /api/tools/call                { server, tool, args }
//   POST /api/resources/read            { server, uri }
//   POST /api/prompts/get               { server, prompt, args }
//   GET  /api/registry/search?q=&cursor=
//   GET  /api/agents                    install status per coding agent
//   POST /api/agents/install            { id }   write endpoint into agent config
//   POST /api/agents/uninstall          { id }   remove endpoint from agent config
//   POST /api/oauth/start               { server }
//   ALL  /mcp                           aggregated MCP endpoint (streamable HTTP)
// =============================================================================

import http from 'http'
import type { Manager } from './manager'
import type { Aggregator } from './aggregate'
import type { RegistrySearcher } from './registry-client'
import type { AgentInstaller } from './agent-install'
import type {
  ContentBlockView,
  PromptGetResponse,
  ResourceReadResponse,
  StateResponse,
  ToolCallResponse,
} from '../shared/types'
import {
  sendJson,
  readBody,
  readJsonObject,
  isAuthorized,
  handleHealth,
  sendUnauthorized,
  serveStaticFile,
  PANEL_CSP,
} from '../_kitserver/http'

export interface AppOptions {
  manager: Manager
  aggregator: Aggregator
  registry: RegistrySearcher
  installer: AgentInstaller
  token: string
  publicDir: string
}

// --- MCP result -> panel-friendly content blocks -----------------------------------

function toContentViews(content: unknown): ContentBlockView[] {
  if (!Array.isArray(content)) return []
  const out: ContentBlockView[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const b = block as Record<string, unknown>
    if (b.type === 'text' && typeof b.text === 'string') {
      out.push({ type: 'text', text: b.text })
    } else if (b.type === 'image' && typeof b.data === 'string') {
      out.push({ type: 'image', src: `data:${typeof b.mimeType === 'string' ? b.mimeType : 'image/png'};base64,${b.data}` })
    } else {
      out.push({ type: 'other', text: JSON.stringify(block, null, 2) })
    }
  }
  return out
}

function resourceContentsToViews(contents: unknown): ContentBlockView[] {
  if (!Array.isArray(contents)) return []
  const out: ContentBlockView[] = []
  for (const item of contents) {
    if (typeof item !== 'object' || item === null) continue
    const c = item as Record<string, unknown>
    if (typeof c.text === 'string') {
      out.push({ type: 'text', text: c.text })
    } else if (typeof c.blob === 'string' && typeof c.mimeType === 'string' && c.mimeType.startsWith('image/')) {
      out.push({ type: 'image', src: `data:${c.mimeType};base64,${c.blob}` })
    } else {
      out.push({ type: 'other', text: JSON.stringify(item, null, 2) })
    }
  }
  return out
}

// --- callback page -----------------------------------------------------------------

function callbackHtml(ok: boolean, message: string): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8"><title>Cate MCP</title>' +
    '<style>body{font:14px -apple-system,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#1b1d23;color:#e6e8ec}div{max-width:420px;text-align:center}</style>' +
    `</head><body><div><h2>${ok ? 'Authorization complete' : 'Authorization failed'}</h2><p>${message.replace(/</g, '&lt;')}</p><p>You can close this window and return to Cate.</p></div></body></html>`
  )
}

// --- the app --------------------------------------------------------------------------

export function createRequestHandler(opts: AppOptions): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  const { manager, aggregator, registry, installer, token, publicDir } = opts

  /** The current aggregated endpoint as an install target (url + bare token). */
  function currentEndpoint(): { url: string; token: string } {
    const ep = manager.getState().endpoint
    return { url: ep.url, token: ep.authHeader.replace(/^Bearer /, '') }
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const pathname = url.pathname
    const method = req.method || 'GET'

    // Readiness probe, auth-exempt so Cate's probe (no token yet) succeeds.
    if (handleHealth(req, res)) return

    // OAuth redirect target. The browser redirect carries no bearer token; the
    // single-use state parameter authenticates the flow instead.
    if (pathname === '/oauth/callback' && method === 'GET') {
      const err = url.searchParams.get('error')
      const state = url.searchParams.get('state') || ''
      const code = url.searchParams.get('code') || ''
      let ok = false
      let message: string
      if (err) {
        message = `the authorization server returned: ${err}${url.searchParams.get('error_description') ? ` (${url.searchParams.get('error_description')})` : ''}`
      } else if (!state || !code) {
        message = 'missing code or state parameter'
      } else {
        const result = await manager.completeAuth(state, code)
        ok = result.ok
        message = result.ok ? `Server "${result.server}" is now connected.` : result.error
      }
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(callbackHtml(ok, message))
      return
    }

    // Everything else requires the injected bearer token.
    if (!isAuthorized(req, token)) {
      sendUnauthorized(res)
      return
    }

    // --- unified MCP endpoint ---------------------------------------------------
    if (pathname === '/mcp') {
      let parsedBody: unknown
      if (method === 'POST') {
        try {
          const text = await readBody(req)
          parsedBody = text === '' ? undefined : JSON.parse(text)
        } catch {
          sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'parse error' }, id: null })
          return
        }
      }
      await aggregator.handleRequest(req, res, parsedBody)
      return
    }

    // --- state -------------------------------------------------------------------
    if (pathname === '/api/state' && method === 'GET') {
      const known = Number(url.searchParams.get('known') ?? NaN)
      if (Number.isFinite(known) && known === manager.serial) {
        const payload: StateResponse = { serial: manager.serial, unchanged: true }
        sendJson(res, 200, payload)
        return
      }
      const payload: StateResponse = { serial: manager.serial, state: manager.getState() }
      sendJson(res, 200, payload)
      return
    }

    // --- activity feed -----------------------------------------------------------
    // Separate from /api/state on purpose: recording a call must not bump the
    // manager serial, so the state poll stays quiet while this churns.
    if (pathname === '/api/activity' && method === 'GET') {
      const raw = Number(url.searchParams.get('limit') ?? NaN)
      const limit = Number.isFinite(raw) && raw > 0 ? raw : undefined
      const log = aggregator.activityLog
      sendJson(res, 200, { ok: true, entries: log.recent(limit), summary: log.summary() })
      return
    }

    // --- server CRUD ----------------------------------------------------------------
    if (pathname === '/api/servers' && method === 'POST') {
      const body = await readJsonObject(req)
      if (!body) {
        sendJson(res, 400, { ok: false, error: 'invalid JSON body' })
        return
      }
      const result = await manager.addServer(body.name, body.config)
      sendJson(res, result.ok ? 200 : result.status, result)
      return
    }

    const serverMatch = pathname.match(/^\/api\/servers\/([^/]+)(?:\/(start|stop|restart|enable|disable))?$/)
    if (serverMatch) {
      const name = decodeURIComponent(serverMatch[1])
      const action = serverMatch[2]
      if (!action && method === 'PATCH') {
        const body = await readJsonObject(req)
        if (!body) {
          sendJson(res, 400, { ok: false, error: 'invalid JSON body' })
          return
        }
        const result = await manager.updateServer(name, body.config)
        sendJson(res, result.ok ? 200 : result.status, result)
        return
      }
      if (!action && method === 'DELETE') {
        const result = await manager.deleteServer(name)
        sendJson(res, result.ok ? 200 : result.status, result)
        return
      }
      if (action && method === 'POST') {
        const result =
          action === 'start'
            ? await manager.startServer(name)
            : action === 'stop'
              ? await manager.stopServer(name)
              : action === 'restart'
                ? await manager.restartServer(name)
                : await manager.setDisabled(name, action === 'disable')
        sendJson(res, result.ok ? 200 : result.status, result)
        return
      }
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }

    // --- playground -----------------------------------------------------------------
    if (pathname === '/api/tools/call' && method === 'POST') {
      const body = await readJsonObject(req)
      if (!body || typeof body.server !== 'string' || typeof body.tool !== 'string') {
        sendJson(res, 400, { ok: false, error: 'body must be { server, tool, args? }' })
        return
      }
      const args = typeof body.args === 'object' && body.args !== null && !Array.isArray(body.args) ? (body.args as Record<string, unknown>) : {}
      const result = await manager.callTool(body.server, body.tool, args)
      if (!result.ok) {
        sendJson(res, result.status, result)
        return
      }
      const raw = result.result as Record<string, unknown>
      const payload: ToolCallResponse = {
        ok: true,
        isError: raw.isError === true,
        content: toContentViews(raw.content),
        structuredContent: raw.structuredContent,
        durationMs: result.durationMs,
      }
      sendJson(res, 200, payload)
      return
    }

    if (pathname === '/api/resources/read' && method === 'POST') {
      const body = await readJsonObject(req)
      if (!body || typeof body.server !== 'string' || typeof body.uri !== 'string') {
        sendJson(res, 400, { ok: false, error: 'body must be { server, uri }' })
        return
      }
      const result = await manager.readResource(body.server, body.uri)
      if (!result.ok) {
        sendJson(res, result.status, result)
        return
      }
      const raw = result.result as Record<string, unknown>
      const payload: ResourceReadResponse = {
        ok: true,
        contents: resourceContentsToViews(raw.contents),
        durationMs: result.durationMs,
      }
      sendJson(res, 200, payload)
      return
    }

    if (pathname === '/api/prompts/get' && method === 'POST') {
      const body = await readJsonObject(req)
      if (!body || typeof body.server !== 'string' || typeof body.prompt !== 'string') {
        sendJson(res, 400, { ok: false, error: 'body must be { server, prompt, args? }' })
        return
      }
      const args: Record<string, string> = {}
      if (typeof body.args === 'object' && body.args !== null && !Array.isArray(body.args)) {
        for (const [k, v] of Object.entries(body.args as Record<string, unknown>)) {
          if (typeof v === 'string') args[k] = v
        }
      }
      const result = await manager.getPrompt(body.server, body.prompt, args)
      if (!result.ok) {
        sendJson(res, result.status, result)
        return
      }
      const raw = result.result as Record<string, unknown>
      const messages = Array.isArray(raw.messages)
        ? (raw.messages as Record<string, unknown>[]).map((m) => ({
            role: typeof m.role === 'string' ? m.role : '',
            content: toContentViews([m.content])[0] ?? { type: 'other' as const, text: '' },
          }))
        : []
      const payload: PromptGetResponse = {
        ok: true,
        description: typeof raw.description === 'string' ? raw.description : undefined,
        messages,
        durationMs: result.durationMs,
      }
      sendJson(res, 200, payload)
      return
    }

    // --- registry ---------------------------------------------------------------------
    if (pathname === '/api/registry/search' && method === 'GET') {
      const result = await registry.search(url.searchParams.get('q') ?? '', url.searchParams.get('cursor'))
      sendJson(res, result.ok ? 200 : 502, result)
      return
    }

    // --- install into coding agents -----------------------------------------------------
    if (pathname === '/api/agents' && method === 'GET') {
      sendJson(res, 200, { ok: true, agents: installer.list(currentEndpoint()) })
      return
    }
    if ((pathname === '/api/agents/install' || pathname === '/api/agents/uninstall') && method === 'POST') {
      const body = await readJsonObject(req)
      if (!body || typeof body.id !== 'string') {
        sendJson(res, 400, { ok: false, error: 'body must be { id }' })
        return
      }
      const result =
        pathname === '/api/agents/install'
          ? installer.install(body.id, currentEndpoint())
          : installer.uninstall(body.id)
      sendJson(res, result.ok ? 200 : 400, result)
      return
    }

    // --- OAuth start --------------------------------------------------------------------
    if (pathname === '/api/oauth/start' && method === 'POST') {
      const body = await readJsonObject(req)
      if (!body || typeof body.server !== 'string') {
        sendJson(res, 400, { ok: false, error: 'body must be { server }' })
        return
      }
      const result = await manager.startAuth(body.server)
      sendJson(res, result.ok ? 200 : result.status, result)
      return
    }

    if (pathname.startsWith('/api/')) {
      sendJson(res, 404, { ok: false, error: 'not found' })
      return
    }

    // --- static panel assets ---------------------------------------------------------------
    if (method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    serveStaticFile(res, publicDir, pathname, PANEL_CSP)
  }

  return (req, res) => {
    void handle(req, res).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(err) })
      else res.end()
    })
  }
}
