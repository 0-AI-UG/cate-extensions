// =============================================================================
// Build script for cate.usage. Produces the shippable dist/ (build.sh tars only
// manifest.json + dist/):
//
//   dist/server.js         Node server, esbuild CJS bundle. ccusage's library
//                          entry (ccusage/data-loader, ESM) is bundled in, so
//                          the artifact needs no node_modules at runtime. Its
//                          dist uses `createRequire(import.meta.url)`, which is
//                          `undefined` after a CJS conversion, so import.meta.url
//                          is defined to a banner-computed file URL for this file.
//   dist/public/app.js     Panel bundle (IIFE) + dist/public/app.css (emitted by
//                          esbuild from the CSS imports).
//   dist/public/index.html Static shell, copied as-is.
// =============================================================================
import { build } from 'esbuild'
import { cpSync, mkdirSync } from 'node:fs'

await build({
  entryPoints: ['src/server.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outfile: 'dist/server.js',
  logLevel: 'warning',
  define: { 'import.meta.url': '__cateImportMetaUrl' },
  banner: {
    js: "const __cateImportMetaUrl = require('node:url').pathToFileURL(__filename).href;",
  },
})

await build({
  entryPoints: ['src/public/app.ts'],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  outfile: 'dist/public/app.js',
  logLevel: 'warning',
})

mkdirSync('dist/public', { recursive: true })
cpSync('src/public/index.html', 'dist/public/index.html')
