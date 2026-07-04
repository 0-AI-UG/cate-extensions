// =============================================================================
// Post-build fixup for the Mermaid extension.
//
// dist/index.html is served by Cate's proxy AT the route root (/ext/<token>/)
// even though it physically lives in dist/. Vite (base './') emits entry refs
// like `./app.js` which would resolve to /ext/<token>/app.js — wrong. Rewrite
// them to `dist/app.js` so they resolve to /ext/<token>/dist/app.js. Every
// downstream URL (mermaid's lazy chunks) is import.meta.url-relative and
// already correct.
// =============================================================================

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const extDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const indexPath = path.join(extDir, 'dist', 'index.html')

const html = await readFile(indexPath, 'utf8')
const fixed = html.replace(/\b(src|href)="\.\//g, '$1="dist/')
await writeFile(indexPath, fixed)
console.log('[postbuild] rewrote entry refs in dist/index.html')
