import { defineConfig } from 'vitest/config';

// Unit tests only: the Playwright suites in tests/e2e need a browser and are run
// with `npm run test:e2e`.
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
