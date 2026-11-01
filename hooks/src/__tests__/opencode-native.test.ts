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

  it.each([false, true])('dispose drains an unawaited idle handler and its final POST (native=%s)', async nativeObserver => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-dispose-'));
    const old = process.env.AGENTDECK_PORT;
    delete process.env.AGENTDECK_PORT;
    let parent!: (value: unknown) => void;
    let health!: (value: unknown) => void;
    let stop!: (value: unknown) => void;
    const parentResult = new Promise(resolve => { parent = resolve; });
    const healthResult = new Promise(resolve => { health = resolve; });
    const stopResult = new Promise(resolve => { stop = resolve; });
    const posts: string[] = [];
    vi.stubGlobal('fetch', async (url: unknown) => {
      if (String(url).endsWith('/health')) return healthResult;
      posts.push(String(url));
      return String(url).endsWith('/opencode_stop') ? stopResult : { ok: true };
    });
    try {
      const file = join(dir, 'agentdeck.mjs');
      writeFileSync(file, opencodePluginSource({ nativeObserver }).replace(
        'import { readFile } from "node:fs/promises";',
        'const readFile = async () => JSON.stringify({ port: 49150 });',
      ));
      const mod = await import(pathToFileURL(file).href);
      const plugin = await mod.AgentDeckObserver({ directory: '/tmp/work', client: { session: { get: () => parentResult } } });
      // Match OpenCode: invoke event without awaiting it, immediately dispose.
      void plugin.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_exit' } } });
      let disposed = false;
      const disposal = plugin.dispose().then(() => { disposed = true; });
      await flush();
      expect(disposed).toBe(false);
      parent({ data: { id: 'ses_exit' } });
      await flush();
      expect(disposed).toBe(false);
      health({ ok: true, json: async () => ({ mode: 'daemon' }) });
      await flush();
      expect(posts.some(url => url.endsWith('/opencode_stop'))).toBe(true);
      expect(disposed).toBe(false);
      stop({ ok: true });
      await disposal;
      expect(disposed).toBe(true);
      const count = posts.length;
      await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 'late' } } });
      expect(posts).toHaveLength(count);
    } finally {
      vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true });
      if (old === undefined) delete process.env.AGENTDECK_PORT; else process.env.AGENTDECK_PORT = old;
    }
  });

  it('dispose has an overall deadline even when a peer never settles', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-dispose-deadline-'));
    const old = process.env.AGENTDECK_PORT;
    delete process.env.AGENTDECK_PORT;
    vi.stubGlobal('fetch', () => new Promise(() => {}));
    try {
      const file = join(dir, 'agentdeck.mjs');
      writeFileSync(file, opencodePluginSource({ nativeObserver: true }).replace(
        'import { readFile } from "node:fs/promises";',
        'const readFile = async () => JSON.stringify({ port: 49150 });',
      ));
      const mod = await import(pathToFileURL(file).href);
      const plugin = await mod.AgentDeckObserver({ directory: '/tmp/work', client: null });
      await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_silent' } } });
      vi.useFakeTimers();
      const disposal = plugin.dispose();
      await vi.advanceTimersByTimeAsync(3000);
      await disposal;
    } finally {
      vi.useRealTimers(); vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true });
      if (old === undefined) delete process.env.AGENTDECK_PORT; else process.env.AGENTDECK_PORT = old;
    }
  });

  it('cancels prompt timers created by a handler that resumes during disposal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-dispose-timer-'));
    const old = process.env.AGENTDECK_PORT;
    delete process.env.AGENTDECK_PORT;
    let parent!: (value: unknown) => void;
    const parentResult = new Promise(resolve => { parent = resolve; });
    const posts: string[] = [];
    vi.stubGlobal('fetch', async (url: unknown) => {
      if (String(url).includes('/hooks/')) posts.push(String(url));
      return { ok: true, json: async () => ({ mode: 'daemon' }) };
    });
    try {
      const file = join(dir, 'agentdeck.mjs');
      writeFileSync(file, opencodePluginSource({ nativeObserver: true }).replace(
        'import { readFile } from "node:fs/promises";',
        'const readFile = async () => JSON.stringify({ port: 49150 });',
      ));
      const mod = await import(pathToFileURL(file).href);
      const plugin = await mod.AgentDeckObserver({ directory: '/tmp/work', client: { session: { get: () => parentResult } } });
      vi.useFakeTimers();
      void plugin.event({ event: { type: 'message.updated', properties: { info: {
        id: 'msg_pending', sessionID: 'ses_pending', role: 'user',
      } } } });
      const disposal = plugin.dispose();
      parent({ data: { id: 'ses_pending' } });
      await disposal;
      const count = posts.length;
      await vi.advanceTimersByTimeAsync(800);
      expect(posts).toHaveLength(count);
      expect(posts.some(url => url.endsWith('/opencode_user_prompt_submit'))).toBe(false);
    } finally {
      vi.useRealTimers(); vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true });
      if (old === undefined) delete process.env.AGENTDECK_PORT; else process.env.AGENTDECK_PORT = old;
    }
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
