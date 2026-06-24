// =============================================================================
// Client-side board fetching. Talks to our own extension server over a relative
// URL so it tunnels through Cate's proxy (which injects the bearer token — the
// webview never holds it). The shared parser already ran server-side; here we
// just type the response.
// =============================================================================

import type { Board, TaskPatch, NewTaskInput } from '../shared/taskmaster'

export interface BoardResponse {
  ok: boolean
  initialized: boolean
  board: Board | null
  path: string | null
  mtime: number | null
  error?: string
}

// Base path of our served panel, e.g. "/ext/<routeToken>/". Relative fetches
// resolve against it and go through the proxy.
const BASE = location.pathname.replace(/[^/]*$/, '')

export async function fetchBoard(): Promise<BoardResponse> {
  const res = await fetch(`${BASE}api/board`, { cache: 'no-store' })
  if (!res.ok) {
    return { ok: false, initialized: false, board: null, path: null, mtime: null, error: `HTTP ${res.status}` }
  }
  return (await res.json()) as BoardResponse
}

async function postJson(path: string, body: unknown): Promise<{ ok: boolean; error?: string; id?: number }> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; id?: number }
    if (!res.ok || data.ok === false) {
      return { ok: false, error: data.error || `HTTP ${res.status}` }
    }
    return { ok: true, id: data.id }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Update one task's fields (status change from drag, inline edits). */
export function patchTask(
  tag: string,
  id: number,
  patch: TaskPatch,
): Promise<{ ok: boolean; error?: string }> {
  return postJson('api/task/patch', { tag, id, patch })
}

/** Create a task; resolves with the new id on success. */
export function createTask(
  tag: string,
  task: NewTaskInput,
): Promise<{ ok: boolean; error?: string; id?: number }> {
  return postJson('api/task', { tag, task })
}
