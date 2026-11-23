import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./src/validation/vitest-hooks.ts'],
    fileParallelism: false,
    testTimeout: 15000
  }
});
