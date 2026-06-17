#!/usr/bin/env node
// Fix node-pty spawn-helper permissions on POSIX (pnpm doesn't preserve
// execute bits from prebuilds). No-op on Windows: node-pty's Windows
// prebuilds are DLLs that don't carry POSIX execute bits.
import { execSync } from 'child_process';

if (process.platform === 'win32') process.exit(0);

try {
  const out = execSync(
    'find node_modules -path "*node-pty*/prebuilds/darwin-*/spawn-helper" 2>/dev/null',
    { encoding: 'utf-8' },
  );
  for (const line of out.split('\n')) {
    const path = line.trim();
    if (!path) continue;
    try {
      execSync(`chmod +x ${JSON.stringify(path)}`, { stdio: 'pipe' });
      console.log(`[postinstall] Fixed spawn-helper permissions: ${path}`);
    } catch {
      /* non-critical */
    }
  }
} catch {
  /* node_modules may not exist yet, or find unavailable */
}
