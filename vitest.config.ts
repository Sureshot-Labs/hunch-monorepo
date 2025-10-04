// Vitest configuration for comprehensive testing
import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./packages/testing/src/setup.ts'],
    testTimeout: 30000, // 30 seconds for integration tests
    hookTimeout: 30000,
    teardownTimeout: 30000,
    include: [
      'apps/*/tests/**/*.test.ts',
      'packages/*/tests/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      'packages/*/src/**/*.test.ts',
    ],
    exclude: [
      'node_modules',
      'dist',
      'build',
      '.next',
      '.nuxt',
      '.output',
      '.vite',
      '.vitest',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      reportsDirectory: './coverage',
      include: [
        'apps/*/src/**/*.ts',
        'packages/*/src/**/*.ts',
      ],
      exclude: [
        'apps/*/src/**/*.test.ts',
        'packages/*/src/**/*.test.ts',
        'apps/*/src/**/*.spec.ts',
        'packages/*/src/**/*.spec.ts',
        'apps/*/src/**/index.ts',
        'packages/*/src/**/index.ts',
        'apps/*/src/**/types.ts',
        'packages/*/src/**/types.ts',
        'apps/*/src/**/constants.ts',
        'packages/*/src/**/constants.ts',
      ],
      thresholds: {
        global: {
          branches: 80,
          functions: 80,
          lines: 80,
          statements: 80,
        },
      },
    },
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true, // Use single fork for database tests
      },
    },
    maxConcurrency: 1, // Run tests sequentially for database consistency
    retry: 2, // Retry failed tests twice
    bail: 0, // Don't bail on first failure
    logLevel: 'info',
    silent: false,
    reporter: ['verbose', 'json'],
    outputFile: {
      json: './test-results.json',
    },
  },
  resolve: {
    alias: {
      '@hunch/shared': resolve(__dirname, './packages/shared/src'),
      '@hunch/db': resolve(__dirname, './packages/db/src'),
      '@hunch/testing': resolve(__dirname, './packages/testing/src'),
    },
  },
  esbuild: {
    target: 'node18',
  },
});
