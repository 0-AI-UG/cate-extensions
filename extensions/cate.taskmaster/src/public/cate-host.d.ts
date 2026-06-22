// =============================================================================
// Ambient typings for the `cate` global injected into this extension's webview
// by Cate's cateHost preload. Self-contained copy of the reverse-API surface so
// the extension type-checks without depending on the Cate repo. Mirrors
// src/shared/cate-host-api.d.ts in the host.
// =============================================================================

interface CateHostTheme {
  id: string
  type: 'dark' | 'light'
  app: Record<string, string>
  terminal: Record<string, string>
}

interface AgentTurnResult {
  text: string
  message: Record<string, unknown> | null
}

interface CateHostWorkspace {
  rootPath: string | null
  branch: string | null
  worktree: string | null
}

interface CateHostStorage {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
  keys(): Promise<string[]>
  panel: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
  }
  onChange(cb: (key?: string) => void): () => void
}

interface CatePanel {
  readonly id: string
  setTitle(title: string): Promise<void>
}

interface CateHost {
  version(): Promise<number>
  panel: CatePanel
  workspace: { get(): Promise<CateHostWorkspace> }
  theme: { get(): Promise<CateHostTheme> }
  editor: {
    openFile(path: string, opts?: { line?: number; column?: number }): Promise<unknown>
  }
  canvas: {
    createPanel(
      type: string,
      opts?: { position?: unknown; size?: unknown; props?: unknown },
    ): Promise<unknown>
  }
  ui: { notify(message: string, level?: 'info' | 'warn' | 'error'): Promise<unknown> }
  agent: {
    open(opts?: { resume?: string }): Promise<{ sessionId: string } | { error: string }>
    send(sessionId: string, prompt: string): Promise<AgentTurnResult | { error: string }>
    dispose(sessionId: string): Promise<unknown>
    run(prompt: string): Promise<AgentTurnResult | { error: string }>
    cancel(): Promise<unknown>
  }
  storage: CateHostStorage
}

interface Window {
  cate?: CateHost
}

declare const cate: CateHost | undefined
