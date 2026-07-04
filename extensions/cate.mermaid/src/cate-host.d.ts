// =============================================================================
// Ambient `cate` global for this extension's webview.
//
// The interface shapes are NOT hand-rolled here — they live in the shared kit
// (kit/cate-host.d.ts), copied into src/_kit/cate-host.d.ts. This file only
// declares the injected `cate` global, typed from that single source of truth,
// so the reverse-API surface can never drift from the kit. Mirrors the host's
// src/shared/cate-host-api.d.ts.
// =============================================================================
import type { CateHost } from './_kit/cate-host'

declare global {
  interface Window {
    cate?: CateHost
  }
  const cate: CateHost | undefined
}

export {}
