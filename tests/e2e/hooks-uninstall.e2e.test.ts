/**
 * Hook uninstall end-to-end — `node hooks/dist/install.js uninstall`, the
 * command `scripts/uninstall.sh` runs, against a temp HOME.
 *
 * `uninstallCodexHooks` was unit-tested but no caller reached it, so uninstall
 * left the AgentDeck block in `~/.codex/config.toml`. This suite runs the real
 * entry point so the wiring, not only the function, is covered.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installCodexHooksIfNeeded } from '../../hooks/src/codex-install.js';
import { OPEN_FENCE } from '../../hooks/src/codex-mini-toml.js';

const ROOT = resolve(__dirname, '../..');
const CLI = join(ROOT, 'hooks/dist/install.js');

let home = '';
let configPath = '';

function uninstall(): { status: number | null; stdout: string } {
  const run = spawnSync(process.execPath, [CLI, 'uninstall'], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, '.config'),
    },
    encoding: 'utf8',
    timeout: 15_000,
  });
  return { status: run.status, stdout: run.stdout };
}

describe('hooks uninstall (real CLI entry point)', () => {
  beforeEach(() => {
    if (!existsSync(CLI)) throw new Error(`${CLI} is missing — run \`pnpm build\` before \`pnpm test:e2e\``);
    home = mkdtempSync(join(tmpdir(), 'agentdeck-uninstall-e2e-'));
    mkdirSync(join(home, '.codex'));
    configPath = join(home, '.codex', 'config.toml');
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('removes the Codex block and keeps what Codex added inside it', () => {
    const original = 'model = "keep"\n[profiles.work]\nmodel = "profile"\n';
    writeFileSync(configPath, original);
    expect(installCodexHooksIfNeeded({ configPath, daemonHttpPort: 9120, platform: 'linux' }).installed).toBe(true);
    // What Codex's toml_edit does with a new root key: it lands after the
    // block's `notify`, inside the fence.
    const installed = readFileSync(configPath, 'utf8');
    const notifyEnd = installed.indexOf('\n', installed.indexOf('\nnotify = ') + 1);
    writeFileSync(configPath, `${installed.slice(0, notifyEnd + 1)}model_reasoning_effort = "high"\n${installed.slice(notifyEnd + 1)}`);

    expect(uninstall().status).toBe(0);

    expect(readFileSync(configPath, 'utf8')).toBe(
      'model = "keep"\nmodel_reasoning_effort = "high"\n[profiles.work]\nmodel = "profile"\n',
    );
  });

  it('keeps a config it cannot edit safely and says so', () => {
    const modified = `${OPEN_FENCE}\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ncommand = "curl /hooks/codex_stop"\ncustom = "keep"\n# <<< AgentDeck managed (do not edit) >>>\n`;
    writeFileSync(configPath, modified);

    const run = uninstall();

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Codex hooks kept:');
    expect(readFileSync(configPath, 'utf8')).toBe(modified);
  });

  it('does nothing to Codex when it was never configured', () => {
    expect(uninstall().status).toBe(0);
    expect(existsSync(configPath)).toBe(false);
  });
});
