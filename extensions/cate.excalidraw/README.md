Excalidraw — the open-source whiteboard, as a Cate canvas panel.

This extension mounts the upstream [Excalidraw](https://github.com/excalidraw/excalidraw)
React component (MIT) inside a Cate panel. It is a thin wrapper, not a
re-implementation: drawing, shapes, arrows, text, images and export are all the
real Excalidraw. Cate's host APIs are wired around it for two things:

- **Theme** — the board follows Cate's light/dark theme (`cate.theme`).
- **Persistence** — each panel autosaves its scene and restores it on reload
  (`cate.storage`, panel-scoped). Open two boards and they keep separate
  drawings; storage is per-workspace, so each project has its own.

Drop as many boards onto the canvas as you like, zoom Cate out, and sketch
next to your editors and terminals.

## Notes

- Everything is vendored and served same-origin under Cate's extension CSP (no
  CDN, no network calls). Excalidraw's woff2 fonts ship inside the extension.
- The CJK handwriting font (Xiaolai, ~12 MB) is omitted to keep the download
  small; CJK text falls back to a system font.
- Image **import** downscaling and font-embedded image **export** rely on Web
  Workers that Excalidraw spins up from `data:`/blob URLs, which the extension
  CSP blocks. Drawing, text and SVG/PNG export of the scene work normally.

## Build

```bash
npm install
npm run build   # vite build + scripts/postbuild.mjs (fix entry refs, vendor fonts)
```

Output lands in `dist/`; the shipped artifact is `manifest.json` + `dist/`.

## Updating Excalidraw

Bump `@excalidraw/excalidraw` in `package.json` and rebuild. The font copy in
`scripts/postbuild.mjs` tracks `dist/prod/fonts` of the installed version.
