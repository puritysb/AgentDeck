import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hermesPluginManifest,
  hermesPluginPath,
  hermesPluginSource,
  installHermesHooksIfNeeded,
  uninstallHermesHooks,
} from '../hermes-install.js';

describe('Hermes observer installer', () => {
  let home: string | undefined;

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
    delete process.env.AGENTDECK_NO_HERMES_HOOKS;
    delete process.env.HERMES_BIN;
  });

  function temporaryHome(): string {
    home = mkdtempSync(join(tmpdir(), 'agentdeck-hermes-'));
    return home;
  }

  it('writes the AgentDeck-owned plugin and is idempotent', () => {
    const root = temporaryHome();
    const first = installHermesHooksIfNeeded({ home: root });
    expect(first.installed).toBe(true);
    expect(first.warning).toContain('Hermes executable not found');

    const manifest = join(first.pluginPath, 'plugin.yaml');
    const source = join(first.pluginPath, '__init__.py');
    expect(readFileSync(manifest, 'utf8')).toBe(hermesPluginManifest());
    expect(readFileSync(source, 'utf8')).toBe(hermesPluginSource());
    const sourceMtime = statSync(source).mtimeMs;

    const second = installHermesHooksIfNeeded({ home: root });
    expect(second).toMatchObject({ installed: false, reason: 'already current' });
    expect(statSync(source).mtimeMs).toBe(sourceMtime);
  });

  it('registers observer hooks and bounds loopback requests', () => {
    const source = hermesPluginSource();
    for (const hook of [
      'on_session_start',
      'pre_llm_call',
      'pre_tool_call',
      'post_tool_call',
      'post_llm_call',
      'on_session_end',
      'on_session_finalize',
    ])
      expect(source).toContain(`ctx.register_hook("${hook}"`);
    for (const event of [
      'hermes_session_start',
      'hermes_user_prompt_submit',
      'hermes_tool_start',
      'hermes_tool_end',
      'hermes_stop',
      'hermes_session_end',
    ])
      expect(source).toContain(event);
    expect(source).toContain('http://127.0.0.1:%s/hooks/%s');
    expect(source).toContain('timeout=0.8');
    expect(source).not.toContain('transform_llm_output');
  });

  it('honours the explicit opt-out without writing files', () => {
    const root = temporaryHome();
    process.env.AGENTDECK_NO_HERMES_HOOKS = '1';
    const result = installHermesHooksIfNeeded({ home: root });
    expect(result).toMatchObject({ installed: false });
    expect(result.reason).toContain('AGENTDECK_NO_HERMES_HOOKS');
    expect(existsSync(result.pluginPath)).toBe(false);
  });

  it('uninstalls only the AgentDeck Hermes plugin directory', () => {
    const root = temporaryHome();
    installHermesHooksIfNeeded({ home: root });
    uninstallHermesHooks({ home: root });
    expect(existsSync(hermesPluginPath(root))).toBe(false);
    uninstallHermesHooks({ home: root });
  });
});
