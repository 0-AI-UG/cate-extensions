# cate.mermaid

A split-pane Mermaid diagram editor: text source on the left, live-rendered diagram on the right, draggable divider between them.

## What it does

- Edits Mermaid source in a plain-text pane and renders it live (debounced) with the bundled `mermaid` package. No server, no network: everything ships in `dist/`, including mermaid's lazy-loaded diagram grammars, so it works under Cate's strict extension CSP.
- No chrome: a floating "..." button over the preview opens the options popover — diagram theme (auto / light / dark / forest / neutral, where auto follows Cate's theme; persisted per panel) and downloads.
- Resizable split: drag the divider to change the editor/preview ratio (persisted per panel), double-click it to reset.
- Autosaves the source per panel through `cate.storage.panel` (debounced, flushed on hide/close), so every Mermaid panel on the canvas keeps its own diagram across reloads.
- Follows Cate's theme: the chrome uses the shared kit tokens, and the `auto` diagram theme picks mermaid's `dark` or `default` from `cate.theme.get()` at load.
- Shows parse and render errors inline under the preview while keeping the last good diagram on screen.
- Exports the rendered diagram as `.svg` or `.png` (rasterized at 2x; the PNG export re-renders with SVG-only labels because `<foreignObject>` HTML labels would taint the canvas).
- Starts with a small example flowchart when a panel has no saved source yet.

## Development

```bash
npm install
npm run build      # vite build + postbuild index.html fixup
npm test           # vitest (autosave, save/load round-trip, error mapping)
npm run typecheck
```

`src/_kit/` is the shared UI kit copied from `kit/` at the repo root; do not edit it here.

## Scopes

`storage` (per-panel autosave), `theme` (light/dark + kit tokens).
