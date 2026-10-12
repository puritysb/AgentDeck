import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const verifier = resolve('apple/scripts/verify-dot-build.py');
const roots: string[] = [];
function fixture(platform: 'macos' | 'ios', mode = 'excluded', binary = 'ordinary app') {
  const app = mkdtempSync(join(tmpdir(), 'agentdeck-dot-build-'));
  roots.push(app);
  const root = platform === 'macos' ? join(app, 'Contents') : app;
  const binaries = platform === 'macos' ? join(root, 'MacOS') : root;
  mkdirSync(binaries, { recursive: true });
  writeFileSync(join(root, 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict>
    <key>CFBundleExecutable</key><string>AgentDeck</string>
    <key>AgentDeckDotSupport</key><string>${mode}</string></dict></plist>`);
  writeFileSync(join(binaries, 'AgentDeck'), binary);
  return { app, root, binaries };
}
const check = (app: string, mode = 'excluded') => execFileSync('python3', [verifier, app, mode], { encoding: 'utf8', stdio: 'pipe' });
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe.each(['macos', 'ios'] as const)('Dot artifact boundary (%s)', (platform) => {
  it('accepts a Store app and rejects a mislabeled preview binary', () => {
    expect(check(fixture(platform).app)).toContain('excluded verified');
    expect(() => check(fixture(platform, 'excluded', 'mangled_DotSurfaceSnapshot').app)).toThrow();
  });
  it('checks the Debug dylib as well as the launcher', () => {
    const f = fixture(platform);
    writeFileSync(join(f.binaries, 'AgentDeck.debug.dylib'), 'mangled_DotHost');
    expect(() => check(f.app)).toThrow();
  });
  it('rejects a leaked MCP resource', () => {
    const f = fixture(platform);
    writeFileSync(join(f.root, 'dot-mcp-contract.json'), '{}');
    expect(() => check(f.app)).toThrow();
  });
  it('requires positive preview evidence and refuses it for Store submission', () => {
    const f = fixture(platform, 'preview', 'mangled_DotSurfaceSnapshot');
    expect(() => check(f.app, 'preview')).toThrow();
    writeFileSync(join(f.root, 'dot-mcp-contract.json'), '{}');
    expect(check(f.app, 'preview')).toContain('preview verified');
    expect(() => check(f.app)).toThrow();
  });
  it('refuses an absent or unexpanded build identity', () => {
    expect(() => check(fixture(platform, '$(AGENTDECK_DOT_SUPPORT)').app)).toThrow();
    expect(() => check(fixture(platform, '').app)).toThrow();
  });
});
