import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Defines configurations specific to watermark-lib tests
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
