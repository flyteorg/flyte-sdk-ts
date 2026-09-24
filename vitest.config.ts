import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Unit tests only by default; `test/e2e/` talks to a real cluster and is
    // opt-in via `pnpm test:e2e`.
    include: ['test/**/*.test.ts'],
    exclude: ['test/e2e/**'],
    environment: 'node',
  },
})
