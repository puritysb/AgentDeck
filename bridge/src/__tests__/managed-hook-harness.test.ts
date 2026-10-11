/**
 * A managed session bridge's hook door reads the harness from the payload
 * (#490 follow-up): `AGENTDECK_PORT` is inherited by every agent started inside
 * the managed PTY, so the port a hook reached says nothing about whose session
 * it is. Payloads are the captured vectors in shared/hook-harness-vectors.json.
 */
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it } from 'vitest';
import { HookServer } from '../hook-server.js';
import { ClaudeCodeAdapter } from '../adapters/claude-code.js';
import { CodexCliAdapter } from '../adapters/codex-cli.js';
import { OpenCodeAdapter } from '../adapters/opencode-adapter.js';
import {
  ManagedHookGate,
  createDaemonHookForwarder,
  forwardTimeoutMs,
  neutralHookReply,
} from '../managed-hook-harness.js';

interface Vector { name: string; event: string; payload: Record<string, unknown> }
const vectors = (JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../../shared/hook-harness-vectors.json'), 'utf8',
)) as { vectors: Vector[] }).vectors;
const vector = (name: string) => {
  const v = vectors.find((x) => x.name.startsWith(name));
  if (!v) throw new Error(`no vector ${name}`);
  return { event: v.event, payload: structuredClone(v.payload) };
};
const codexStop = () => vector('Codex Stop (captured)');
const claudeStop = () => vector('Claude Code Stop');

describe('ManagedHookGate', () => {
  it('each managed adapter owns its own harness (the codex bridge is agentType codex-cli)', () => {
    const harness = (a: object) => (a as { hookHarness(): string }).hookHarness();
    expect(harness(new ClaudeCodeAdapter())).toBe('claude-code');
    expect(harness(new CodexCliAdapter())).toBe('codex');
    expect(harness(new OpenCodeAdapter())).toBe('opencode');
  });

  it('a Claude bridge keeps Claude hooks and hands Codex hooks away', () => {
    const gate = new ManagedHookGate(() => 'claude-code');
    const claude = claudeStop();
    expect(gate.classify(claude.event, claude.payload)).toEqual({ kind: 'own', eventName: 'Stop', quiet: false });
    const codex = codexStop();
    expect(gate.classify(codex.event, codex.payload)).toEqual({ kind: 'foreign' });
    expect(gate.classify('codex_stop', codexStop().payload)).toEqual({ kind: 'foreign' });
    expect(gate.classify('opencode_stop', {})).toEqual({ kind: 'foreign' });
  });

  it('a Codex bridge re-routes its own Claude-shaped hook and ingests the twin once', () => {
    const gate = new ManagedHookGate(() => 'codex');
    expect(gate.classify('codex_stop', codexStop().payload, 1_000)).toEqual({ kind: 'own', eventName: 'codex_stop', quiet: false });
    const twin = codexStop();
    expect(gate.classify(twin.event, twin.payload, 1_500)).toEqual({ kind: 'drop' });
    const claude = claudeStop();
    expect(gate.classify(claude.event, claude.payload)).toEqual({ kind: 'foreign' });
  });

  it('a Codex bridge answers a re-routed Claude-shaped command with nothing', () => {
    const gate = new ManagedHookGate(() => 'codex');
    const codex = codexStop();
    expect(gate.classify(codex.event, codex.payload)).toEqual({ kind: 'own', eventName: 'codex_stop', quiet: true });
    expect(neutralHookReply('UserPromptSubmit', true)).toBe('');
    expect(neutralHookReply('codex_stop', true)).toBe(JSON.stringify({ received: true }));
    expect(neutralHookReply('Notification')).toBe(JSON.stringify({ received: true }));
    expect(neutralHookReply('PreToolUse')).toBe('');
  });

  it('drops a Codex payload with no Codex route on either bridge', () => {
    const dropped = vector('a Codex payload for an event Codex has no AgentDeck route');
    expect(new ManagedHookGate(() => 'claude-code').classify(dropped.event, dropped.payload)).toEqual({ kind: 'drop' });
  });
});

describe('createDaemonHookForwarder', () => {
  const daemons: Server[] = [];
  afterEach(async () => {
    while (daemons.length) await new Promise((r) => daemons.pop()!.close(r));
  });

  async function fakeDaemon(reply: string): Promise<{ port: number; seen: Array<{ url?: string; pid?: string; body: string }> }> {
    const seen: Array<{ url?: string; pid?: string; body: string }> = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        seen.push({ url: req.url, pid: req.headers['x-agentdeck-pid'] as string | undefined, body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(reply);
      });
    });
    daemons.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { port: (server.address() as AddressInfo).port, seen };
  }

  it('never forwards to itself or to a missing daemon', async () => {
    const self = createDaemonHookForwarder({ ownPort: () => 9123, findDaemonPort: async () => 9123 });
    expect(await self('codex_stop', '{}', {})).toBeNull();
    const none = createDaemonHookForwarder({ ownPort: () => 9123, findDaemonPort: async () => null });
    expect(await none('codex_stop', '{}', {})).toBeNull();
  });

  it('reuses a resolved daemon port and spends the lookup time from the hook budget', async () => {
    let clock = 0;
    let lookups = 0;
    const signals: number[] = [];
    const forward = createDaemonHookForwarder({
      ownPort: () => 9123,
      findDaemonPort: async () => { lookups++; clock += 1_500; return 9120; },
      now: () => clock,
      fetchImpl: (async (_url: string, init: { signal: AbortSignal }) => {
        signals.push(clock);
        void init;
        return new Response('', { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(await forward('codex_stop', '{}', {})).not.toBeNull();
    expect(await forward('codex_stop', '{}', {})).not.toBeNull();
    expect(lookups).toBe(1);
    clock += 10_000;
    await forward('codex_stop', '{}', {});
    expect(lookups).toBe(2);
    // A lookup that ate the whole 2 s budget forwards nothing.
    const slow = createDaemonHookForwarder({
      ownPort: () => 9123,
      findDaemonPort: async () => { clock += 2_500; return 9120; },
      now: () => clock,
      fetchImpl: (async () => { throw new Error('must not fetch'); }) as unknown as typeof fetch,
    });
    expect(await slow('codex_stop', '{}', {})).toBeNull();
  });

  it('bounds the wait just under each hook script’s own deadline', () => {
    expect(forwardTimeoutMs('PreToolUse')).toBeLessThan(60_000);
    expect(forwardTimeoutMs('Stop')).toBeLessThan(10_000);
    expect(forwardTimeoutMs('codex_stop')).toBeLessThanOrEqual(2_000);
  });

  it('a nested Codex hook on a managed Claude bridge reaches the daemon unchanged and never drives the Claude session', async () => {
    const daemon = await fakeDaemon('');
    const bridge = new HookServer();
    bridge.setOwnHarness('claude-code');
    bridge.setForeignHookForwarder(createDaemonHookForwarder({ ownPort: () => -1, findDaemonPort: async () => daemon.port }));
    const emitted: string[] = [];
    bridge.on('hook', ({ event }: { event: string }) => emitted.push(event));
    await bridge.listen(0);
    const port = ((bridge as unknown as { server: Server }).server.address() as AddressInfo).port;
    try {
      const codex = codexStop();
      const res = await fetch(`http://127.0.0.1:${port}/hooks/${codex.event}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-AgentDeck-Pid': '4242' },
        body: JSON.stringify(codex.payload),
      });
      expect(await res.text()).toBe('');
      const claude = claudeStop();
      await fetch(`http://127.0.0.1:${port}/hooks/${claude.event}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(claude.payload),
      });
    } finally {
      await bridge.close();
    }
    expect(emitted).toEqual(['Stop']);
    expect(daemon.seen).toHaveLength(1);
    expect(daemon.seen[0].url).toBe('/hooks/Stop');
    expect(daemon.seen[0].pid).toBe('4242');
    expect(JSON.parse(daemon.seen[0].body)).toEqual(codexStop().payload);
  });
});
