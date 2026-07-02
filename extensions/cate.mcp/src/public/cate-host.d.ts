// =============================================================================
// Ambient typings for the `cate` global injected into this extension's webview
// by Cate's cateHost preload. Only the surface this panel actually uses
// (theme, ui.notify, storage, editor.openFile, panel) plus the rest of the
// documented API for completeness. Mirrors kit/cate-host.d.ts.
// =============================================================================

interface CateHostTheme {
  id: string
  type: 'dark' | 'light'
  app: Record<string, string>
  terminal: Record<string, string>
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
    createPanel(type: string, opts?: { url?: string; filePath?: string }): Promise<unknown>
  }
  ui: { notify(message: string, level?: 'info' | 'warn' | 'error'): Promise<unknown> }
  storage: CateHostStorage
}

interface Window {
  cate?: CateHost
}

declare const cate: CateHost | undefined
