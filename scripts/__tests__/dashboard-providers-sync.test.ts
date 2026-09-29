import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
it('native validators and provider menus follow the daemon vocabulary', () => {
  expect(() => execFileSync(process.execPath, [fileURLToPath(new URL('../generate-dashboard-providers.mjs', import.meta.url)), '--check'])).not.toThrow();
});
