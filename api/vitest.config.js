import { defineConfig } from 'vitest/config';

// Fast tests: pure helpers and mocked-dependency regression tests. Database tests live in tests/integration
// and run with `npm run test:integration` (they create and drop their own disposable PostgreSQL database).
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.js', 'tests/regression/**/*.test.js'],
    setupFiles: ['tests/setup-env.js'],
  },
});
