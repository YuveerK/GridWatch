import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  include: ['audit/ingestion-audit.test.js'],
  globalSetup: ['tests/integration/global-setup.js'],
  setupFiles: ['tests/setup-env.js'],
  fileParallelism: false, testTimeout: 30_000, hookTimeout: 60_000,
} });
