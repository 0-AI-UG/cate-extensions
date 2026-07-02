// Copy the panel's HTML shell and the sql.js WASM engine into dist/ as the
// final build step. esbuild emits the JS/CSS bundles; this places the two
// runtime files it can't inline:
//   - src/public/index.html  -> dist/public/index.html (the shell)
//   - node_modules/sql.js/dist/sql-wasm.wasm -> dist/sql-wasm.wasm
//     (loaded by src/db.ts via locateFile; keeps the viewer self-contained so
//      the shipped artifact needs no external SQLite install or node_modules).
import { cpSync, mkdirSync } from 'node:fs'

mkdirSync('dist/public', { recursive: true })
cpSync('src/public/index.html', 'dist/public/index.html')
cpSync('node_modules/sql.js/dist/sql-wasm.wasm', 'dist/sql-wasm.wasm')
