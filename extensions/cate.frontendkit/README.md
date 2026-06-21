# Frontend Kit

A frontend-only Cate extension. It ships static assets (`index.html`, `app.js`,
`style.css`) and no server. Cate's proxy serves the files and the panel talks to
Cate through the injected `window.cate` bridge.

It uses:

- `cate.version`, `cate.panel.id`, `cate.workspace.get`, `cate.theme.get`
- `cate.storage` get/set/keys/delete, `cate.storage.panel`, `cate.storage.onChange`
- `cate.editor.openFile`, `cate.canvas.createPanel`, `cate.panel.setTitle`, `cate.ui.notify`

The server-backed counterpart is [`cate.kitchensink`](../cate.kitchensink).

## Layout

```
cate.frontendkit/
  manifest.json     # frontend: index.html, no server
  index.html
  app.js
  style.css
  cate-host.d.ts    # ambient types for the `cate` global (editor only)
```

No build step. `build.sh` tars the directory as-is, with `manifest.json` at the
tar root.
