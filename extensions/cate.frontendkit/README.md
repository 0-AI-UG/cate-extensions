# Frontend Kit — Cate Frontend-only Extension API Demo

A **frontend-only** Cate extension: it ships nothing but static assets
(`index.html` + `app.js` + `style.css`) and has **no server**. Cate's proxy
serves these files directly from the installed extension dir, and the panel
talks to Cate purely through the injected `window.cate` bridge.

This is the companion to [`cate.kitchensink`](../cate.kitchensink), which is
*server-backed*. Frontend Kit covers the same `window.cate` surface but
deliberately exercises the **frontend-only serving path** instead of the
HTTP/WebSocket tunnel and the `CATE_API` reverse channel (which require a
server).

## What it proves

| Layer | How it's exercised |
| --- | --- |
| **Static (frontend-only) serving** | The whole panel loads from `manifest.frontend` (`index.html`) and its relative `app.js` / `style.css` under `/ext/<routeToken>/`. No server, no tunnel. |
| **cateHost bridge** | `cate.version`, `cate.panel.id`, `cate.workspace.get`, `cate.theme.get` (theme tokens applied to the panel's CSS vars). |
| **Storage (full API)** | `cate.storage.get/set` (autosaved notes), `cate.storage.keys`, `cate.storage.delete`, `cate.storage.panel.get/set` (per-panel counter), `cate.storage.onChange` (a live event counter). |
| **Reverse API (page → Cate)** | `cate.editor.openFile('package.json')` and an `{ line, column }` variant, `cate.canvas.createPanel('extension', …)`, `cate.panel.setTitle`, `cate.ui.notify`. |
| **Manifest variety** | Two panels (`main` + `about`), a panel `icon`, and per-panel `defaultSize`. |

## How Cate runs it

There is no spawn step. Cate's proxy resolves the extension's root dir and
serves files statically with a strict CSP (`connect-src 'self'`, external
script only). The webview loads
`http://127.0.0.1:<proxyPort>/ext/<routeToken>/?cateExt&cateWs&catePanel`; the
`cateHost` preload reads those query params and exposes `window.cate`.

## Layout

```
cate.frontendkit/
  manifest.json     # frontend-only manifest (no server; frontend: index.html)
  index.html        # the panel
  app.js            # drives every reachable bridge method (plain classic script)
  style.css         # themed via cate.theme.get tokens
  cate-host.d.ts    # ambient types for the injected `cate` global (editor only)
```

No build step: `app.js` is hand-authored plain JavaScript, so the extension
ships as-is. `cate-extensions/build.sh` tars the directory directly (it has no
`dist/`), and `manifest.json` sits at the tar root.
