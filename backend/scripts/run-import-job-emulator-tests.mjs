import { execFileSync } from 'node:child_process';
execFileSync(process.execPath, ['--experimental-test-module-mocks', '--import', 'tsx', '--test', 'scripts/tests/emulator/import-jobs.test.ts'], {
  stdio: 'inherit', env: { ...process.env, FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080' },
});
