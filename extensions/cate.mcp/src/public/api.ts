// =============================================================================
// Client-side API wrappers. All requests go over RELATIVE URLs so they tunnel
// through Cate's proxy, which injects the bearer token; the webview never
// holds the token itself. Every wrapper resolves (never throws) with an
// { ok, error? } shape so callers can surface failures inline.
// =============================================================================

import type {
  PromptGetResponse,
  ResourceReadResponse,
  ServerConfigInput,
  StateResponse,
  ToolCallResponse,
} from '../shared/types'
import type { RegistryEntry } from '../shared/registry'

// Base path of our served panel, e.g. "/ext/<routeToken>/".
const BASE = location.pathname.replace(/[^/]*$/, '')

async function request<T extends { ok?: boolean; error?: string }>(
  path: string,
  init?: RequestInit,
): Promise<T | { ok: false; error: string }> {
  try {
    const res = await fetch(`${BASE}${path}`, { cache: 'no-store', ...init })
    const data = (await res.json().catch(() => ({}))) as T
    if (!res.ok && data.ok !== true) {
      return { ok: false, error: data.error || `HTTP ${res.status}` }
    }
    return data
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function postJson<T extends { ok?: boolean; error?: string }>(path: string, body: unknown, method = 'POST') {
  return request<T>(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export type SimpleResult = { ok: true } | { ok: false; error: string }

export function fetchState(known: number | null): Promise<StateResponse | { ok: false; error: string }> {
  return request<StateResponse & { ok?: boolean; error?: string }>(
    known === null ? 'api/state' : `api/state?known=${known}`,
  )
}

export function addServer(name: string, config: ServerConfigInput): Promise<SimpleResult> {
  return postJson('api/servers', { name, config }) as Promise<SimpleResult>
}

export function updateServer(name: string, config: ServerConfigInput): Promise<SimpleResult> {
  return postJson(`api/servers/${encodeURIComponent(name)}`, { config }, 'PATCH') as Promise<SimpleResult>
}

export function deleteServer(name: string): Promise<SimpleResult> {
  return request(`api/servers/${encodeURIComponent(name)}`, { method: 'DELETE' }) as Promise<SimpleResult>
}

export type ServerAction = 'start' | 'stop' | 'restart' | 'enable' | 'disable'

export function serverAction(name: string, action: ServerAction): Promise<SimpleResult> {
  return postJson(`api/servers/${encodeURIComponent(name)}/${action}`, {}) as Promise<SimpleResult>
}

export function callTool(server: string, tool: string, args: Record<string, unknown>): Promise<ToolCallResponse> {
  return postJson<ToolCallResponse>('api/tools/call', { server, tool, args }) as Promise<ToolCallResponse>
}

export function readResource(server: string, uri: string): Promise<ResourceReadResponse> {
  return postJson<ResourceReadResponse>('api/resources/read', { server, uri }) as Promise<ResourceReadResponse>
}

export function getPrompt(server: string, prompt: string, args: Record<string, string>): Promise<PromptGetResponse> {
  return postJson<PromptGetResponse>('api/prompts/get', { server, prompt, args }) as Promise<PromptGetResponse>
}

export interface RegistrySearchResult {
  ok: boolean
  error?: string
  entries?: RegistryEntry[]
  nextCursor?: string | null
}

export function registrySearch(q: string, cursor: string | null): Promise<RegistrySearchResult> {
  const params = new URLSearchParams()
  if (q) params.set('q', q)
  if (cursor) params.set('cursor', cursor)
  return request<RegistrySearchResult>(`api/registry/search?${params.toString()}`) as Promise<RegistrySearchResult>
}

export interface OAuthStartResult {
  ok: boolean
  error?: string
  authUrl?: string | null
}

export function oauthStart(server: string): Promise<OAuthStartResult> {
  return postJson<OAuthStartResult>('api/oauth/start', { server }) as Promise<OAuthStartResult>
}
