import { defineConfig } from 'vitest/config';
import os from 'node:os';
import path from 'node:path';

const testDb =
  process.env.TEST_DATABASE_URL || 'postgresql://sm:sm@127.0.0.1:55432/sampaimana_test?schema=public';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./test/global-setup.mjs'],
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 60000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: testDb,
      JWT_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
      RATE_LIMIT_DISABLED: 'true',
      UPLOAD_DIR: path.join(os.tmpdir(), 'sampaimana-test-uploads'),
      PUBLIC_URL: 'http://localhost:5173',
    },
  },
});
