import { defineConfig } from 'vitest/config';

// Isolated audit evidence, deliberately excluded from the normal regression suite.
export default defineConfig({
  test: {
    include: ['audit/engine-review.test.js'],
    setupFiles: ['tests/setup-env.js'],
  },
});
