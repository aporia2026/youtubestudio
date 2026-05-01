import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(root, 'src'),
    },
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 10_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/lib/**/*.ts'],
      exclude: [
        'src/lib/**/*.d.ts',
        'src/lib/migrations/00*_*.ts',
      ],
      thresholds: {
        // Per-file thresholds will be enforced as the relevant code lands in
        // later PRs. PR #1 establishes the harness; coverage gates expand in
        // step with the auth, scoping, and admin code.
        lines: 0,
        statements: 0,
        functions: 0,
        branches: 0,
      },
    },
  },
});
