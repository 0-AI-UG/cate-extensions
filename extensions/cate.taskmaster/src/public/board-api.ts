// =============================================================================
// Client-side board fetching. Talks to our own extension server over a relative
// URL so it tunnels through Cate's proxy (which injects the bearer token — the
// webview never holds it). The shared parser already ran server-side; here we
// just type the response.
// =============================================================================

import type { Board } from '../shared/taskmaster'

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
