import { defineConfig } from 'vitest/config';

// Real PostgreSQL, real transactions and locks. globalSetup creates a randomly named database on the configured server
// (never the configured database itself), applies every migration to it, and drops it afterwards.
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.js'],
    globalSetup: ['tests/integration/global-setup.js'],
    setupFiles: ['tests/setup-env.js'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
