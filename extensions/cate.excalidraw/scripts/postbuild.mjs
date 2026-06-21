// =============================================================================
// Post-build fixups for the Excalidraw extension.
//
// 1. dist/index.html is served by Cate's proxy AT the route root (/ext/<token>/)
//    even though it physically lives in dist/. Vite (base './') emits entry refs
//    like `./app.js` which would resolve to /ext/<token>/app.js — wrong. Rewrite
//    them to `dist/app.js` so they resolve to /ext/<token>/dist/app.js. Every
//    downstream URL is import.meta.url-relative and already correct.
//
// 2. Copy Excalidraw's runtime woff2 font tree into dist/fonts/ so the fonts the
//    component fetches from EXCALIDRAW_ASSET_PATH (= …/dist/) are served
//    same-origin. The CJK family (Xiaolai, ~12 MB of the 13 MB total) is omitted
//    to keep the artifact small; it is only fetched when CJK glyphs are typed,
//    in which case the browser falls back to a system font.
// =============================================================================

import { cp, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const extDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distDir = path.join(extDir, 'dist')

// 1. Rewrite entry asset refs in the served HTML: ./ -> dist/
const indexPath = path.join(distDir, 'index.html')
const html = await readFile(indexPath, 'utf8')
const fixed = html.replace(/\b(src|href)="\.\//g, '$1="dist/')
await writeFile(indexPath, fixed)
console.log('[postbuild] rewrote entry refs in dist/index.html')

// 2. Vendor the runtime fonts (minus the large CJK family).
const fontsSrc = path.join(
  extDir,
  'node_modules',
  '@excalidraw',
  'excalidraw',
  'dist',
  'prod',
  'fonts',
)
const fontsDest = path.join(distDir, 'fonts')
const OMIT = new Set(['Xiaolai'])
await cp(fontsSrc, fontsDest, {
  recursive: true,
  filter: (src) => !src.split(path.sep).some((seg) => OMIT.has(seg)),
})
console.log('[postbuild] copied fonts -> dist/fonts (omitted: ' + [...OMIT].join(', ') + ')')
