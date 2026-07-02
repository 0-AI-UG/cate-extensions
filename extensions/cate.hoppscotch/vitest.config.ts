import { defineConfig } from 'vitest/config'

// The extension's helpers (src/config.ts, src/pscotch.ts, src/rewrite.ts) are
// pure and import no Electron / electron-log, so no stubbing is needed here.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
