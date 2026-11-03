import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { vi } from 'vitest';
import { tmpdir } from 'os';
import { join, sep } from 'path';

// AGENTDECK_DATA_DIR alone does not isolate legacy credential migration.
// Node module home discovery uses a private fixture; existing tests may still
// opt into a different HOME under the OS temporary root without changing the
// invoking shell's environment. Subprocess fixtures need explicit temp paths.
const testHome = vi.hoisted(() => {
  const state = { home: '', inheritedHome: '', temporaryPrefix: '' };
  return { state, homedir: () => {
    if (!state.home) throw new Error('Test home fixture is not initialized');
    const explicit = process.env.HOME;
    return explicit && explicit !== state.inheritedHome && explicit.startsWith(state.temporaryPrefix)
      ? explicit : state.home;
  } };
});
vi.mock('os', async original => {
  const actual = await original<typeof import('os')>();
  return { ...actual, homedir: testHome.homedir, default: { ...actual, homedir: testHome.homedir } };
});
vi.mock('node:os', async original => {
  const actual = await original<typeof import('node:os')>();
  return { ...actual, homedir: testHome.homedir, default: { ...actual, homedir: testHome.homedir } };
});
const dataDir = mkdtempSync(join(tmpdir(), 'agentdeck-vitest-'));
testHome.state.home = join(dataDir, 'home');
testHome.state.inheritedHome = process.env.HOME ?? '';
testHome.state.temporaryPrefix = tmpdir().replace(/[\\/]+$/, '') + sep;
mkdirSync(testHome.state.home, { mode: 0o700 });
process.env.AGENTDECK_DATA_DIR = dataDir;
// Default child fixtures inherit this explicit data directory. A synthetic
// token prevents their ordinary auth lookup from importing a live legacy key.
writeFileSync(join(dataDir, 'auth-token'), randomBytes(16).toString('hex') + '\n', { mode: 0o600 });

// No test starts the real Foundation Models helper. In a checkout without the
// bundled binary, such as a fresh worktree, a test that reached session
// activity or a summarizer compiled the helper into a temp data dir and
// launched it. A launch that hung in dyld outlived its worker: 12 such
// processes on 2026-10-19, the oldest 31 h old. Tests of the helper stub
// their own path with vi.stubEnv.
process.env.AGENTDECK_FM_HELPER = join(dataDir, 'no-fm-helper');

// Pin TZ so timeline-renderer snapshots are stable regardless of host TZ.
// CI sets this via env (Asia/Seoul); pinning here covers local dev across
// macOS, Linux, and Windows without each contributor having to set TZ.
process.env.TZ = 'Asia/Seoul';

// TUI capabilities are resolved at import time. Pin the locale before modules
// load so Unicode snapshots also work in minimal containers and non-UTF-8 shells.
process.env.LANG = 'en_US.UTF-8';
delete process.env.LC_ALL;
delete process.env.LC_CTYPE;

process.once('exit', () => {
  rmSync(dataDir, { recursive: true, force: true });
});
