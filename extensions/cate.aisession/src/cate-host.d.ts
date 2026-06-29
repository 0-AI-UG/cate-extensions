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

interface CateHostWorkspace {
  rootPath: string | null
  branch: string | null
  worktree: string | null
}

/** A file the user dragged onto this panel, delivered to `cate.files.onDrop`. */
interface CateDroppedFile {
  name: string
  path: string | null
  text: string
  size?: number
  truncated?: boolean
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
  editor: { openFile(path: string, opts?: { line?: number; column?: number }): Promise<unknown> }
  ui: { notify(message: string, level?: 'info' | 'warn' | 'error'): Promise<unknown> }
  files: { onDrop(cb: (files: CateDroppedFile[]) => void): () => void }
}

interface Window {
  cate?: CateHost
}

declare const cate: CateHost | undefined
