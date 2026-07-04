import { defineConfig } from 'vitest/config'

// The tested modules (src/shape.ts, src/cache.ts) are pure: no ccusage import,
// no Electron, no filesystem, no network. Plain Node environment.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
