import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { it } from 'vitest';

it.skipIf(process.platform === 'win32')('verifies Pages report archive provenance and allowed data', () => {
  execFileSync('python3', ['-B', resolve(__dirname, 'fixtures/pages-artifact-checks.py')]);
});
