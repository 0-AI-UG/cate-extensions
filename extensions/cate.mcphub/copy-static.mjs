// Copy the panel's static assets (HTML/CSS) alongside the compiled app.js.
// tsc only emits JS, so the non-TS files are copied here as the final build step.
import { cpSync, mkdirSync } from 'node:fs'

mkdirSync('dist/public', { recursive: true })
for (const file of ['shell.html', 'style.css']) {
  cpSync(`src/public/${file}`, `dist/public/${file}`)
}
