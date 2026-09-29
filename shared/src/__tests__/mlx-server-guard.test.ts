import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
it('operator server guard rejects replacement and exits on allocator failure', () => {
  const script = fileURLToPath(new URL('../../../scripts/__tests__/mlx-server-guard.test.py', import.meta.url));
  expect(() => execFileSync('python3', [script], { stdio: 'pipe', timeout: 10_000 })).not.toThrow();
});
