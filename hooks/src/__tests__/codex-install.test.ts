import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  applyManagedBlock,
  removeManagedBlock,
  hasTopLevelKeyOutsideFence,
  hasTableOutsideFence,
  quoted,
  OPEN_FENCE,
  CLOSE_FENCE,
} from '../codex-mini-toml.js';
import {
  managedBlockBody,
  installCodexHooksIfNeeded,
  uninstallCodexHooks,
} from '../codex-install.js';

// ─── codex-mini-toml ────────────────────────────────────────────────────

describe('codex-mini-toml: applyManagedBlock', () => {
  it('appends fence when absent', () => {
    const original = `model = "gpt-5"\n\n[profiles.work]\nprovider = "openai"`;
    const updated = applyManagedBlock(original, 'notify = ["echo", "hi"]');

    expect(updated).toContain('model = "gpt-5"');
    expect(updated).toContain('[profiles.work]');
    expect(updated).toContain('provider = "openai"');
    expect(updated).toContain(OPEN_FENCE);
    expect(updated).toContain(CLOSE_FENCE);
    expect(updated).toContain('notify = ["echo", "hi"]');
  });

  it('replaces existing fence block', () => {
    const original = [
      'model = "gpt-5"',
      '',
      OPEN_FENCE,
      'notify = ["old", "snippet"]',
      CLOSE_FENCE,
      '',
      '[profiles.work]',
      'provider = "openai"',
    ].join('\n');

    const updated = applyManagedBlock(original, 'notify = ["new", "snippet"]');
    expect(updated).not.toContain('"old", "snippet"');
    expect(updated).toContain('notify = ["new", "snippet"]');
    expect(updated).toContain('model = "gpt-5"');
    expect(updated).toContain('[profiles.work]');
    expect(updated).toContain('provider = "openai"');
  });

  it('apply twice is idempotent', () => {
    const original = 'model = "gpt-5"\n';
    const once = applyManagedBlock(original, 'key = 1');
    const twice = applyManagedBlock(once, 'key = 1');
    expect(once).toBe(twice);
  });

  it('moves Codex hook trust state out of the managed fence', () => {
    const original = [
      'model = "gpt-5"',
      '',
      OPEN_FENCE,
      '[features]',
      'hooks = true',
      '',
      '[[hooks.Stop]]',
      '[[hooks.Stop.hooks]]',
      'type = "command"',
      'command = "old"',
      '',
      '[hooks.state]',
      '',
      '[hooks.state."/Users/me/.codex/config.toml:stop:0:0"]',
      'trusted_hash = "sha256:abc"',
      '',
      '# OTel trace exporter',
      '[otel.trace_exporter.otlp-http]',
      'endpoint = "http://127.0.0.1:9120/otel/v1/traces"',
      CLOSE_FENCE,
    ].join('\n');

    const updated = applyManagedBlock(original, '[features]\nhooks = true');
    const managed = updated.split(OPEN_FENCE)[1].split(CLOSE_FENCE)[0];
    const outside = updated.split(CLOSE_FENCE)[1];

    expect(managed).not.toContain('[hooks.state]');
    expect(outside).toContain('[hooks.state]');
    expect(outside).toContain('trusted_hash = "sha256:abc"');
    expect(outside).not.toContain('# OTel trace exporter');
    expect(applyManagedBlock(updated, '[features]\nhooks = true')).toBe(updated);
  });
});

describe('codex-mini-toml: removeManagedBlock', () => {
  it('leaves user content', () => {
    const original = `model = "gpt-5"\n\n[profiles.work]\nprovider = "openai"`;
    const withFence = applyManagedBlock(original, 'notify = []');
    const stripped = removeManagedBlock(withFence);

    expect(stripped).not.toContain('notify');
    expect(stripped).not.toContain(OPEN_FENCE);
    expect(stripped).not.toContain(CLOSE_FENCE);
    expect(stripped).toContain('model = "gpt-5"');
    expect(stripped).toContain('[profiles.work]');
    expect(stripped).toContain('provider = "openai"');
  });

  it('is idempotent without fence', () => {
    const original = 'model = "gpt-5"\n';
    expect(removeManagedBlock(original)).toBe(original);
  });
});

describe('codex-mini-toml: hasTopLevelKeyOutsideFence', () => {
  it('detects user notify key', () => {
    const withUser = `notify = ["python3", "/usr/local/bin/notify.py"]\nmodel = "gpt-5"`;
    expect(hasTopLevelKeyOutsideFence(withUser, 'notify')).toBe(true);
  });

  it('ignores notify key inside table', () => {
    const inTable = `model = "gpt-5"\n\n[tui.notifications]\nnotify = "always"`;
    expect(hasTopLevelKeyOutsideFence(inTable, 'notify')).toBe(false);
  });

  it('ignores notify key inside fence', () => {
    const withFence = applyManagedBlock('model = "gpt-5"', 'notify = ["x"]');
    expect(hasTopLevelKeyOutsideFence(withFence, 'notify')).toBe(false);
  });
});

describe('codex-mini-toml: hasTableOutsideFence', () => {
  it('detects user [otel] table', () => {
    const withUser = `model = "gpt-5"\n\n[otel]\nexporter = "none"`;
    expect(hasTableOutsideFence(withUser, 'otel')).toBe(true);
  });

  it('detects user [otel.exporter] dotted table', () => {
    const withUser = `[otel.exporter]\nkind = "otlp"`;
    expect(hasTableOutsideFence(withUser, 'otel')).toBe(true);
  });

  it('detects array-of-table header [[hooks.Stop]]', () => {
    const withUser = `[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"`;
    expect(hasTableOutsideFence(withUser, 'hooks')).toBe(true);
  });

  it('ignores Codex hook trust state outside fence', () => {
    const withState = [
      '[hooks.state]',
      '',
      '[hooks.state."/Users/me/.codex/config.toml:stop:0:0"]',
      'trusted_hash = "sha256:abc"',
    ].join('\n');
    expect(hasTableOutsideFence(withState, 'hooks')).toBe(false);
  });

  it('ignores [otel] inside fence', () => {
    const withFence = applyManagedBlock('', '[otel]\nexporter = "otlp-http"');
    expect(hasTableOutsideFence(withFence, 'otel')).toBe(false);
  });

  it('ignores [otelfoo] (word boundary)', () => {
    const withUnrelated = '[otelfoo]\nkey = 1';
    expect(hasTableOutsideFence(withUnrelated, 'otel')).toBe(false);
  });
});

describe('codex-mini-toml: quoted', () => {
  it('escapes backslash and double quote', () => {
    expect(quoted('a\\b"c')).toBe('"a\\\\b\\"c"');
  });

  it('escapes newline and tab', () => {
    expect(quoted('a\nb\tc')).toBe('"a\\nb\\tc"');
  });

  it('passes simple ASCII', () => {
    expect(quoted('hello')).toBe('"hello"');
  });
});

// ─── codex-install: managedBlockBody ────────────────────────────────────

describe('codex-install: managedBlockBody', () => {
  it('includes current and retired App Store daemon.json paths', () => {
    const body = managedBlockBody({ daemonHttpPort: 9120 });
    expect(body).toContain('Library/Containers/bound.serendipity.agent.deck/Data/Library/Application Support/AgentDeck/daemon.json');
    expect(body).toContain('Library/Containers/bound.serendipity.agentdeck.dashboard/Data/Library/Application Support/AgentDeck/daemon.json');
    expect(body).toContain('group.bound.serendipity.agent.deck/daemon.json');
    expect(body).toContain('group.bound.serendipity.agentdeck.dashboard/daemon.json');
  });

  it('roundtrip preserves user TOML byte-for-byte (load-bearing)', () => {
    const original = [
      '# Codex config — handcrafted',
      '',
      'model = "gpt-5"',
      'approval_policy = "on-request"',
      '',
      '[profiles.work]',
      'provider = "openai"',
      'approval_policy = "never"',
      '',
      '[mcp_servers.foo]',
      'command = "/usr/local/bin/foo-server"',
      'args = ["--port", "9000"]',
      '',
      '[history]',
      'max_bytes = 10485760',
    ].join('\n');

    const body = managedBlockBody({
      includeNotify: true,
      includeOtel: true,
      otelEndpoint: 'http://127.0.0.1:9120/otel/v1/traces',
    });
    const withFence = applyManagedBlock(original, body);
    const stripped = removeManagedBlock(withFence);
    expect(stripped).toBe(original);
  });

  it('matches Codex schema (lifecycle hooks + endpoints + notify dummy)', () => {
    const body = managedBlockBody({
      includeNotify: true,
      includeOtel: true,
      otelEndpoint: 'http://127.0.0.1:9120/otel/v1/traces',
    });
    const withFence = applyManagedBlock('', body);
    expect(withFence).toContain('[features]');
    expect(withFence).toContain('hooks = true');
    expect(withFence).toContain('[[hooks.UserPromptSubmit]]');
    expect(withFence).toContain('[[hooks.PreToolUse]]');
    expect(withFence).toContain('[[hooks.PostToolUse]]');
    expect(withFence).toContain('[[hooks.Stop]]');
    expect(withFence).toContain('/hooks/codex_user_prompt_submit');
    expect(withFence).toContain('/hooks/codex_tool_start');
    expect(withFence).toContain('/hooks/codex_tool_end');
    expect(withFence).toContain('/hooks/codex_stop');
    expect(withFence).toContain('--connect-timeout 0.2 --max-time 0.8');
    expect(withFence).toContain('notify =');
    expect(withFence).toContain('[otel.trace_exporter.otlp-http]');
    expect(withFence).toContain('/otel/v1/traces');
    expect(withFence).toContain('protocol = "json"');
    // Dummy 4th element so the JSON payload Codex appends lands at $1.
    expect(withFence).toContain('"agentdeck-notify"');
  });

  it('omits conflicting optional channels when asked', () => {
    const body = managedBlockBody({
      includeNotify: false,
      includeOtel: false,
      otelEndpoint: 'http://127.0.0.1:9120/otel/v1/traces',
    });
    expect(body).toContain('hooks = true');
    expect(body).toContain('[[hooks.Stop]]');
    expect(body).not.toContain('notify =');
    expect(body).not.toContain('[otel.trace_exporter.otlp-http]');
  });
});

// ─── codex-install: end-to-end file I/O ─────────────────────────────────

describe('codex-install: install / uninstall (file I/O)', () => {
  let tmp: string;
  let configPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'codex-install-test-'));
    configPath = join(tmp, 'config.toml');
    delete process.env.AGENTDECK_NO_CODEX_HOOKS;
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    delete process.env.AGENTDECK_NO_CODEX_HOOKS;
  });

  it('creates config with fence when file is absent', () => {
    const result = installCodexHooksIfNeeded({ configPath, daemonHttpPort: 9120 });
    expect(result.installed).toBe(true);
    const text = readFileSync(configPath, 'utf-8');
    expect(text).toContain(OPEN_FENCE);
    expect(text).toContain('hooks = true');
    expect(text).toContain('http://127.0.0.1:9120/otel/v1/traces');
  });

  it('preserves user content when installing into existing config', () => {
    const userText = `model = "gpt-5"\n[profiles.work]\nprovider = "openai"\n`;
    writeFileSync(configPath, userText, 'utf-8');
    installCodexHooksIfNeeded({ configPath, daemonHttpPort: 9120 });
    const text = readFileSync(configPath, 'utf-8');
    expect(text).toContain('model = "gpt-5"');
    expect(text).toContain('[profiles.work]');
    expect(text).toContain('provider = "openai"');
    expect(text).toContain(OPEN_FENCE);
  });

  it('skips when user already has [features] table outside fence', () => {
    writeFileSync(configPath, `[features]\nhooks = true\n`, 'utf-8');
    const result = installCodexHooksIfNeeded({ configPath });
    expect(result.installed).toBe(false);
    expect(result.reason).toContain('[features]');
  });

  it('skips when user already has [hooks] table outside fence', () => {
    writeFileSync(configPath, `[[hooks.Stop]]\nmatcher = ""\n`, 'utf-8');
    const result = installCodexHooksIfNeeded({ configPath });
    expect(result.installed).toBe(false);
    expect(result.reason).toContain('[hooks]');
  });

  it('omits notify when user has top-level notify', () => {
    writeFileSync(configPath, `notify = ["python3", "/x.py"]\nmodel = "gpt-5"\n`, 'utf-8');
    installCodexHooksIfNeeded({ configPath, daemonHttpPort: 9120 });
    const text = readFileSync(configPath, 'utf-8');
    // User notify preserved
    expect(text).toContain('"python3", "/x.py"');
    // Managed block has no notify
    const managed = text.split(OPEN_FENCE)[1].split(CLOSE_FENCE)[0];
    expect(managed).not.toContain('notify =');
    // Lifecycle hooks still installed
    expect(managed).toContain('hooks = true');
  });

  it('omits OTel when user has [otel] table', () => {
    writeFileSync(configPath, `[otel]\nexporter = "otlp-grpc"\n`, 'utf-8');
    installCodexHooksIfNeeded({ configPath, daemonHttpPort: 9120 });
    const text = readFileSync(configPath, 'utf-8');
    expect(text).toContain('exporter = "otlp-grpc"');
    const managed = text.split(OPEN_FENCE)[1].split(CLOSE_FENCE)[0];
    expect(managed).not.toContain('[otel.trace_exporter.otlp-http]');
    expect(managed).toContain('hooks = true');
  });

  it('uninstall strips fence and preserves user content', () => {
    const userText = `model = "gpt-5"\n[profiles.work]\nprovider = "openai"\n`;
    writeFileSync(configPath, userText, 'utf-8');
    installCodexHooksIfNeeded({ configPath, daemonHttpPort: 9120 });
    uninstallCodexHooks({ configPath });
    const text = readFileSync(configPath, 'utf-8');
    expect(text).not.toContain(OPEN_FENCE);
    expect(text).not.toContain('hooks = true');
    expect(text).toContain('model = "gpt-5"');
    expect(text).toContain('[profiles.work]');
  });

  it('uninstall is idempotent when no config exists', () => {
    expect(() => uninstallCodexHooks({ configPath })).not.toThrow();
    expect(existsSync(configPath)).toBe(false);
  });

  it('honours AGENTDECK_NO_CODEX_HOOKS=1 opt-out', () => {
    process.env.AGENTDECK_NO_CODEX_HOOKS = '1';
    const result = installCodexHooksIfNeeded({ configPath, daemonHttpPort: 9120 });
    expect(result.installed).toBe(false);
    expect(result.reason).toContain('AGENTDECK_NO_CODEX_HOOKS');
    expect(existsSync(configPath)).toBe(false);
  });

  it('install is idempotent (same port → no rewrite)', () => {
    installCodexHooksIfNeeded({ configPath, daemonHttpPort: 9120 });
    const firstStat = readFileSync(configPath, 'utf-8');
    installCodexHooksIfNeeded({ configPath, daemonHttpPort: 9120 });
    const secondStat = readFileSync(configPath, 'utf-8');
    expect(secondStat).toBe(firstStat);
  });

  it('preserves Codex hook trust state across reinstall', () => {
    installCodexHooksIfNeeded({ configPath, daemonHttpPort: 9120 });
    const withStateInsideFence = readFileSync(configPath, 'utf-8').replace(
      CLOSE_FENCE,
      [
        '[hooks.state]',
        '',
        '[hooks.state."/Users/me/.codex/config.toml:stop:0:0"]',
        'trusted_hash = "sha256:abc"',
        '',
        CLOSE_FENCE,
      ].join('\n')
    );
    writeFileSync(configPath, withStateInsideFence, 'utf-8');

    const result = installCodexHooksIfNeeded({ configPath, daemonHttpPort: 9120 });
    expect(result.installed).toBe(true);

    const text = readFileSync(configPath, 'utf-8');
    const managed = text.split(OPEN_FENCE)[1].split(CLOSE_FENCE)[0];
    const outside = text.split(CLOSE_FENCE)[1];
    expect(managed).not.toContain('[hooks.state]');
    expect(outside).toContain('trusted_hash = "sha256:abc"');

    installCodexHooksIfNeeded({ configPath, daemonHttpPort: 9120 });
    expect(readFileSync(configPath, 'utf-8')).toBe(text);
  });
});
