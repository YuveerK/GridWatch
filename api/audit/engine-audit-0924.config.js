import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  include: ['audit/engine-audit-0924.test.js'],
  setupFiles: ['tests/setup-env.js'],
} });
