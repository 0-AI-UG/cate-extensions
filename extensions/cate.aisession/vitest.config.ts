import { defineConfig } from 'vitest/config'

// Parser tests are pure functions (no DOM); run them in node. Scoped to this
// extension so it doesn't inherit Cate's root vitest config.
export default defineConfig({
  test: {
    root: __dirname,
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
