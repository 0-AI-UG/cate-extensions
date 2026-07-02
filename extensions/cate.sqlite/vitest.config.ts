import { defineConfig } from 'vitest/config'

// The extension's helpers (src/db.ts, src/scan.ts) import no Electron /
// electron-log, so no stubbing is needed here. Node environment; sql.js loads
// its WASM from node_modules during the integration tests.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
