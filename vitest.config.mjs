import { defineConfig } from 'vitest/config';
import os from 'node:os';
import path from 'node:path';

const baseEnv = {
  NODE_ENV: 'test',
  JWT_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
  RATE_LIMIT_DISABLED: 'true',
  UPLOAD_DIR: path.join(os.tmpdir(), 'sampaimana-test-uploads'),
  PUBLIC_URL: 'http://localhost:5173',
};

const testDb =
  process.env.TEST_DATABASE_URL || 'postgresql://sm:sm@127.0.0.1:55432/sampaimana_test?schema=public';

export default defineConfig({
  test: {
    // Integration files share one database; run files one at a time (unit files take milliseconds anyway).
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.js'],
      exclude: ['src/server.js', 'src/docs/**'],
      reporter: ['text-summary', 'text'],
    },
    projects: [
      {
        // Pure logic, no database. Runs anywhere: `pnpm test:unit`.
        test: {
          name: 'unit',
          environment: 'node',
          include: ['test/unit/**/*.test.mjs'],
          env: { ...baseEnv, DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused' },
        },
      },
      {
        // HTTP + real Postgres. Needs TEST_DATABASE_URL (CI provides a service container).
        test: {
          name: 'integration',
          environment: 'node',
          include: ['test/integration/**/*.test.mjs'],
          globalSetup: ['./test/integration/global-setup.mjs'],
          testTimeout: 20000,
          hookTimeout: 60000,
          env: { ...baseEnv, DATABASE_URL: testDb },
        },
      },
    ],
  },
});
