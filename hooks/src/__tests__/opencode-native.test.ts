import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { opencodePluginSource, OPENCODE_NATIVE_SETUP, installOpenCodeHooksIfNeeded, uninstallOpenCodeHooks } from '../opencode-install.js';

const flush = () => new Promise(r => setTimeout(r, 40));
describe('native OpenCode observer', () => {
  beforeEach(() => vi.stubEnv('AGENTDECK_NO_OPENCODE_HOOKS', undefined));
  afterEach(() => vi.unstubAllEnvs());
  it('CLI setup preserves a Swift-owned observer and refuses edits; uninstall removes only verified owned files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-native-owner-'));
    const file = join(dir, OPENCODE_NATIVE_SETUP.pluginFilename);
    const receiver = join(dir, OPENCODE_NATIVE_SETUP.receiverFilename);
    const source = opencodePluginSource({ nativeObserver: true });
    const bytes = JSON.stringify({ owner: OPENCODE_NATIVE_SETUP.owner, installedSHA256: createHash('sha256').update(source).digest('hex'), port: 49150 });
    try {
      writeFileSync(file, source); writeFileSync(receiver, bytes);
      expect(installOpenCodeHooksIfNeeded({ pluginPath: file }).installed).toBe(true);
      expect(readFileSync(file, 'utf8')).toBe(source);
      expect(readFileSync(receiver, 'utf8')).toBe(bytes);
      writeFileSync(file, source + '// user edit');
      expect(installOpenCodeHooksIfNeeded({ pluginPath: file }).installed).toBe(false);
      uninstallOpenCodeHooks({ pluginPath: file });
      expect(readFileSync(file, 'utf8')).toBe(source + '// user edit');
      writeFileSync(file, source);
      uninstallOpenCodeHooks({ pluginPath: file });
      expect(() => readFileSync(file)).toThrow();
      expect(() => readFileSync(receiver)).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('bundles the canonical source and setup names without drift', () => {
    const data = JSON.parse(readFileSync('apple/AgentDeck/Resources/OpenCodeObserver.json', 'utf8'));
    expect(data).toEqual({ ...OPENCODE_NATIVE_SETUP, source: opencodePluginSource({ nativeObserver: true }),
      cliSHA256: createHash('sha256').update(opencodePluginSource()).digest('hex') });
  });
  it('a loaded plugin follows explicit receiver edits, refuses invalid selection and never polls commands', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-native-'));
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', async (url: unknown, init?: { body?: string }) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
      if (String(url).includes('/opencode/commands')) return new Promise(() => {});
      return { ok: true, json: async () => ({ mode: 'daemon' }) };
    });
    const old = process.env.AGENTDECK_PORT;
    delete process.env.AGENTDECK_PORT;
    try {
      const file = join(dir, 'agentdeck.mjs');
      writeFileSync(file, opencodePluginSource({ nativeObserver: true }));
      const mod = await import(pathToFileURL(file).href);
      const client = { session: { get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id } }) } };
      const plugin = await mod.AgentDeckObserver({ directory: '/tmp/work', client });
      for (const port of [49150, 49151]) {
        writeFileSync(join(dir, OPENCODE_NATIVE_SETUP.receiverFilename), JSON.stringify({ port }));
        await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_native' } } });
        await flush();
        expect(calls.some(c => c.url === `http://127.0.0.1:${port}/hooks/opencode_stop` && c.body?.observer_only === true)).toBe(true);
      }
      expect(calls.some(c => c.url.includes('/opencode/commands'))).toBe(false);
      const before = calls.length;
      writeFileSync(join(dir, OPENCODE_NATIVE_SETUP.receiverFilename), '{"port":false}');
      await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_native' } } });
      await flush();
      expect(calls).toHaveLength(before);
    } finally {
      vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true });
      if (old === undefined) delete process.env.AGENTDECK_PORT; else process.env.AGENTDECK_PORT = old;
    }
  });
});
