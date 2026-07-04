// =============================================================================
// Cate extension host typings (canonical, shared via the kit).
//
// Ambient typings for the `cate` global injected into an extension's webview by
// Cate's cateHost preload. This is the single source of truth; `scripts/
// sync-kit.mjs` copies it into each extension's `src/_kit/` so extensions
// type-check without depending on the Cate repo. Mirrors the host's
// `src/shared/cate-host-api.d.ts`.
// =============================================================================

export interface CateHostTheme {
  id: string
  type: 'dark' | 'light'
  app: Record<string, string>
  terminal: Record<string, string>
}

export interface AgentTurnResult {
  text: string
  message: Record<string, unknown> | null
}

export interface CateHostWorkspace {
  rootPath: string | null
  branch: string | null
  worktree: string | null
}

export interface CateHostStorage {
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

export interface CatePanel {
  readonly id: string
  setTitle(title: string): Promise<void>
}

/** A file the user dragged onto this panel, delivered to `cate.files.onDrop`. */
export interface CateDroppedFile {
  name: string
  path: string | null
  text: string
  size?: number
  truncated?: boolean
}

export interface CateHost {
  version(): Promise<number>
  panel: CatePanel
  workspace: { get(): Promise<CateHostWorkspace> }
  theme: { get(): Promise<CateHostTheme> }
  editor: {
    openFile(path: string, opts?: { line?: number; column?: number }): Promise<unknown>
  }
  canvas: {
    /** Open a new panel on the canvas. The host honors `position`, `url`,
     *  `filePath`, `extensionId`, and `extensionPanelId`; it ignores anything
     *  else (there is no `size`/`props` — mirrors the host's cate-host-api.d.ts). */
    createPanel(
      type: string,
      opts?: {
        position?: unknown
        /** Browser panels: the URL to open. */
        url?: string
        /** Editor panels: workspace-relative file to open. */
        filePath?: string
        /** Extension panels: which extension to mount... */
        extensionId?: string
        /** ...and which of its declared panels. */
        extensionPanelId?: string
      },
    ): Promise<unknown>
  }
  ui: { notify(message: string, level?: 'info' | 'warn' | 'error'): Promise<unknown> }
  files: { onDrop(cb: (files: CateDroppedFile[]) => void): () => void }
  agent: {
    open(opts?: { resume?: string }): Promise<{ sessionId: string } | { error: string }>
    send(sessionId: string, prompt: string): Promise<AgentTurnResult | { error: string }>
    dispose(sessionId: string): Promise<unknown>
    run(prompt: string): Promise<AgentTurnResult | { error: string }>
    cancel(): Promise<unknown>
  }
  storage: CateHostStorage
}
