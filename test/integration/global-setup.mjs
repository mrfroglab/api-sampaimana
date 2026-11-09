import { execSync } from 'node:child_process';

export default function setup() {
  const url =
    process.env.TEST_DATABASE_URL || 'postgresql://sm:sm@127.0.0.1:55432/sampaimana_test?schema=public';
  if (!/test/i.test(url)) {
    throw new Error('TEST_DATABASE_URL harus menunjuk ke database khusus test (nama mengandung "test").');
  }
  // Applies pending migrations only (non-destructive). Each test file truncates its own data.
  execSync('npx prisma migrate deploy', { stdio: 'inherit', env: { ...process.env, DATABASE_URL: url } });
}
