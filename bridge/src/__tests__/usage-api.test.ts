import { homedir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCredSources, resolveOAuthCredentials, type CredSources } from '../usage-api.js';

/** Build a CredSources with sane defaults; override per case. Spies let us assert which
 *  I/O path was taken (critically, that `runSecurityCli` never fires off-darwin). */
function sources(overrides: Partial<CredSources> = {}): CredSources {
  return {
    platform: 'win32',
    configDir: 'C:\\Users\\test\\.claude',
    env: {},
    readCredsFile: vi.fn(() => null),
    runSecurityCli: vi.fn(() => null),
    ...overrides,
  };
}

const OAUTH_JSON = (accessToken: string, expiresAt?: number) =>
  JSON.stringify({ claudeAiOauth: { accessToken, expiresAt, refreshToken: 'r', scopes: ['x'] } });

describe('resolveOAuthCredentials', () => {
  it('darwin: parses the Keychain blob and never reads a file', () => {
    const readCredsFile = vi.fn(() => null);
    const runSecurityCli = vi.fn(() => OAUTH_JSON('mac-token', 1_900_000_000_000));
    const creds = resolveOAuthCredentials(sources({ platform: 'darwin', readCredsFile, runSecurityCli }));
    expect(creds).toEqual({ accessToken: 'mac-token', expiresAt: 1_900_000_000_000 });
    expect(runSecurityCli).toHaveBeenCalledOnce();
    expect(readCredsFile).not.toHaveBeenCalled();
  });

  it('win32: reads <configDir>/.credentials.json and never spawns the security CLI', () => {
    const readCredsFile = vi.fn(() => OAUTH_JSON('win-token', 1_888_000_000_000));
    const runSecurityCli = vi.fn(() => 'SHOULD NOT BE CALLED');
    const creds = resolveOAuthCredentials(sources({
      platform: 'win32',
      configDir: 'C:\\Users\\dougw\\.claude',
      readCredsFile,
      runSecurityCli,
    }));
    expect(creds).toEqual({ accessToken: 'win-token', expiresAt: 1_888_000_000_000 });
    // The lazy thunk stays unevaluated on the non-darwin path — no subprocess, no window.
    expect(runSecurityCli).not.toHaveBeenCalled();
    // `join` uses the host separator, so assert with `join` to stay OS-agnostic on CI.
    expect(readCredsFile).toHaveBeenCalledWith(join('C:\\Users\\dougw\\.claude', '.credentials.json'));
  });

  it('win32: CLAUDE_CODE_OAUTH_TOKEN takes precedence over the file, expiresAt undefined', () => {
    const readCredsFile = vi.fn(() => OAUTH_JSON('file-token', 1_888_000_000_000));
    const creds = resolveOAuthCredentials(sources({
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'env-token' },
      readCredsFile,
    }));
    expect(creds).toEqual({ accessToken: 'env-token', expiresAt: undefined });
    // Env wins — the file is not even read.
    expect(readCredsFile).not.toHaveBeenCalled();
  });

  it('win32: an empty CLAUDE_CODE_OAUTH_TOKEN falls through to the file', () => {
    const readCredsFile = vi.fn(() => OAUTH_JSON('file-token'));
    const creds = resolveOAuthCredentials(sources({
      env: { CLAUDE_CODE_OAUTH_TOKEN: '' },
      readCredsFile,
    }));
    expect(creds).toEqual({ accessToken: 'file-token', expiresAt: undefined });
    expect(readCredsFile).toHaveBeenCalledOnce();
  });

  it('win32: a whitespace-only CLAUDE_CODE_OAUTH_TOKEN falls through to the file', () => {
    const readCredsFile = vi.fn(() => OAUTH_JSON('file-token'));
    const creds = resolveOAuthCredentials(sources({
      env: { CLAUDE_CODE_OAUTH_TOKEN: '   ' },
      readCredsFile,
    }));
    expect(creds).toEqual({ accessToken: 'file-token', expiresAt: undefined });
    expect(readCredsFile).toHaveBeenCalledOnce();
  });

  it('win32: a padded env token is trimmed before use', () => {
    const creds = resolveOAuthCredentials(sources({ env: { CLAUDE_CODE_OAUTH_TOKEN: '  env-token  ' } }));
    expect(creds).toEqual({ accessToken: 'env-token', expiresAt: undefined });
  });

  it('linux: honors a relocated configDir (CLAUDE_CONFIG_DIR)', () => {
    const expectedPath = join('/custom/cfg', '.credentials.json');
    const readCredsFile = vi.fn((p: string) =>
      p === expectedPath ? OAUTH_JSON('relocated', 1_777_000_000_000) : null);
    const creds = resolveOAuthCredentials(sources({
      platform: 'linux',
      configDir: '/custom/cfg',
      readCredsFile,
    }));
    expect(creds).toEqual({ accessToken: 'relocated', expiresAt: 1_777_000_000_000 });
    expect(readCredsFile).toHaveBeenCalledWith(expectedPath);
  });

  it('win32: neither file nor env → null, no throw', () => {
    const creds = resolveOAuthCredentials(sources({ env: {}, readCredsFile: vi.fn(() => null) }));
    expect(creds).toBeNull();
  });

  it('win32: malformed / partial JSON → null, never throws', () => {
    for (const raw of ['not json', '{}', '{"claudeAiOauth":{}}', '{"claudeAiOauth":{"accessToken":42}}']) {
      const creds = resolveOAuthCredentials(sources({ readCredsFile: vi.fn(() => raw) }));
      expect(creds).toBeNull();
    }
  });

  it('win32: valid token but non-numeric expiresAt → token kept, expiresAt undefined', () => {
    const raw = JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt: 'nope' } });
    const creds = resolveOAuthCredentials(sources({ readCredsFile: vi.fn(() => raw) }));
    expect(creds).toEqual({ accessToken: 'tok', expiresAt: undefined });
  });

  it('darwin: security CLI returns null (no keychain entry) → null', () => {
    const creds = resolveOAuthCredentials(sources({ platform: 'darwin', runSecurityCli: vi.fn(() => null) }));
    expect(creds).toBeNull();
  });
});

describe('buildCredSources (production wiring)', () => {
  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  });

  it('wires the real platform, env, and default configDir', () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    const s = buildCredSources();
    expect(s.platform).toBe(process.platform);
    expect(s.env).toBe(process.env);
    expect(s.configDir).toBe(join(homedir(), '.claude'));
  });

  it('honors CLAUDE_CONFIG_DIR when set', () => {
    process.env.CLAUDE_CONFIG_DIR = join('some', 'custom', 'cfg');
    expect(buildCredSources().configDir).toBe(join('some', 'custom', 'cfg'));
  });

  it('passes the security + file readers as UN-invoked function references (lazy thunks)', () => {
    // Guards the core safety claim: the `security` subprocess must never be eagerly
    // called while assembling sources. If someone wrote `runSecurityCli: runSecurityCli()`
    // the value would be `string | null`, not a function, and this fails.
    const s = buildCredSources();
    expect(typeof s.runSecurityCli).toBe('function');
    expect(typeof s.readCredsFile).toBe('function');
  });
});
