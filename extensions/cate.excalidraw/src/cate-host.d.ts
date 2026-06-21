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

interface CateHost {
  version(): Promise<number>
  theme: {
    get(): Promise<CateHostTheme>
  }
  storage: CateHostStorage
}

interface Window {
  cate: CateHost
}

declare const cate: CateHost
