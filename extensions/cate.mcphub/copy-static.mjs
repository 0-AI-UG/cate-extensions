// Copy the panel's HTML alongside the bundled app.js / app.css (esbuild emits
// the JS+CSS bundle; the HTML shell is copied here as the final build step).
import { cpSync, mkdirSync } from 'node:fs'

mkdirSync('dist/public', { recursive: true })
cpSync('src/public/shell.html', 'dist/public/shell.html')
