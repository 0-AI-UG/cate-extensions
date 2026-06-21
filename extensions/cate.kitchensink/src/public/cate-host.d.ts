// =============================================================================
// Ambient typings for the `cate` global injected into this extension's webview
// by Cate's cateHost preload. This is a self-contained copy of the reverse-API
// surface so the extension type-checks without depending on the Cate repo.
// Mirrors src/shared/cate-host-api.d.ts in the host.
// =============================================================================

/** Theme tokens handed to a guest by `cate.theme.get()`. */
interface CateHostTheme {
  id: string
  type: 'dark' | 'light'
  /** Merged app CSS-var palette (key without leading `--`). */
  app: Record<string, string>
  /** Terminal ANSI palette. */
  terminal: Record<string, string>
}

/** Workspace context handed to a guest by `cate.workspace.get()`. */
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
  /** Subscribe to storage changes (external edits or writes from other panels).
   *  Returns an unsubscribe function. */
  onChange(cb: (key?: string) => void): () => void
}

interface CatePanel {
  /** This panel instance's id. */
  readonly id: string
  setTitle(title: string): Promise<void>
}

interface CateHost {
  /** API version int, for feature detection. */
  version(): Promise<number>
  panel: CatePanel
  workspace: {
    get(): Promise<CateHostWorkspace>
  }
  theme: {
    get(): Promise<CateHostTheme>
  }
  editor: {
    openFile(path: string, opts?: { line?: number; column?: number }): Promise<unknown>
  }
  canvas: {
    createPanel(
      type: string,
      opts?: { position?: unknown; size?: unknown; props?: unknown },
    ): Promise<unknown>
  }
  ui: {
    notify(message: string, level?: 'info' | 'warn' | 'error'): Promise<unknown>
  }
  /** Run one background turn through Cate's bundled agent (requires the `agent`
   *  scope + first-use user consent). Resolves with the agent's final text.
   *  Long-lived — a turn can take minutes. One run per extension at a time. */
  agent: {
    run(prompt: string): Promise<{ text: string } | { error: string }>
    cancel(): Promise<unknown>
  }
  storage: CateHostStorage
}

interface Window {
  cate: CateHost
}

declare const cate: CateHost
