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

/** One open browser panel, as reported by `cate.browser.list()`. */
export interface CateBrowserTab {
  panelId: string
  title: string
  url: string
  focused: boolean
}

/** Navigation state of a browser panel, from `cate.browser.current()`. */
export interface CateBrowserState {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
}

/** One interactable element in an accessibility `snapshot()`. `ref` is an opaque
 *  handle to pass back to `click`/`type`; only valid for the snapshot it came
 *  from (re-snapshot after a navigation or mutation). */
export interface CateBrowserRef {
  ref: string
  role: string
  name: string
  value?: string
}

/** Accessibility snapshot of a browser panel, from `cate.browser.snapshot()`. */
export interface CateBrowserSnapshot {
  url: string
  title: string
  refs: CateBrowserRef[]
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
  /** Drive Cate's browser panels (requires the `browser` scope). These panels
   *  hold the user's real, logged-in browser session — cookies, auth, and all —
   *  so anything the user can reach while signed in, the extension can too. Treat
   *  it accordingly. Every method targets a single panel; `panelId` picks it, and
   *  when omitted the host uses the focused (or only) browser panel. `snapshot`
   *  returns opaque element `ref`s to feed back to `click`/`type`; re-snapshot
   *  after any navigation because refs don't survive it. `screenshot` returns a
   *  host filesystem `path` (a webview guest can't read it directly; a
   *  server-backed extension can — see docs/extensions.md). */
  browser: {
    list(): Promise<CateBrowserTab[]>
    open(opts: { url: string; panelId?: string }): Promise<{ panelId: string; url: string }>
    back(opts?: { panelId?: string }): Promise<{ ok: true }>
    forward(opts?: { panelId?: string }): Promise<{ ok: true }>
    reload(opts?: { panelId?: string }): Promise<{ ok: true }>
    current(opts?: { panelId?: string }): Promise<CateBrowserState>
    screenshot(opts?: { panelId?: string }): Promise<{ path: string }>
    snapshot(opts?: { panelId?: string }): Promise<CateBrowserSnapshot>
    click(opts: { ref: string; panelId?: string }): Promise<{ ok: true }>
    type(opts: { ref: string; text: string; panelId?: string }): Promise<{ ok: true }>
  }
  storage: CateHostStorage
}
