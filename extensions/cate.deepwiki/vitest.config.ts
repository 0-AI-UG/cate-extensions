import { defineConfig } from 'vitest/config'

// The extension's helpers (src/auth.ts, src/config.ts) are pure and import no
// Electron / electron-log, so no stubbing is needed here. Node environment.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
