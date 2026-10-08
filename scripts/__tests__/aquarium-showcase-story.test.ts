import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import WebSocket from '../../bridge/node_modules/ws/wrapper.mjs';
import { showcaseStory, showcaseEventsForPhase } from '../aquarium-showcase-story.mjs';

const epoch = 1_800_000_000_000;
const frame = (at: number) => showcaseEventsForPhase(showcaseStory.phases.findIndex(p => p.at === at), epoch, true, 19522);
const rows = (at: number) => frame(at).find(e => e.type === 'sessions_list')!.sessions;

describe('isolated public intro showcase', () => {
  it('keeps one observed Hermes and one of each other agent without a duplicate primary identity', () => {
    for (const phase of showcaseStory.phases) {
      const events = frame(phase.at);
      const sessions = events.find(e => e.type === 'sessions_list')!.sessions;
      expect(new Set(sessions.map(s => s.id)).size).toBe(sessions.length);
      expect(sessions.filter(s => s.agentType === 'hermes')).toHaveLength(phase.at >= 9000 ? 1 : 0);
      expect(sessions.every(s => s.controlMode === 'observed' && s.port === 0)).toBe(true);
      const state = events[0];
      expect(state.focusedSessionId).toBe('');
      expect(state.gatewayConnected).toBe(phase.at >= 7000);
      if (sessions.length) expect(state.sessionId).toBe(sessions[0].id);
    }
    expect(rows(9000).map(s => s.agentType)).toEqual(['claude-code', 'codex-cli', 'opencode', 'openclaw', 'hermes']);
  });

  it('shows CI only on its waiting owner, preserves invocation identity and explicitly clears results', () => {
    for (const [at, phase, waiting] of [[12000, 'queued', true], [16000, 'running', true], [22000, 'passed', false]] as const) {
      const sessions = rows(at);
      const ci = sessions.filter(s => s.waitingOn);
      expect(ci).toHaveLength(1);
      expect(ci[0].id).toBe('showcase-codex');
      expect(ci[0].state).toBe('idle');
      expect(ci[0].waitingOn).toMatchObject({ phase, agentWaiting: waiting, openedAt: epoch + 12000 });
      expect(ci[0].waitingOn.runUrl).toBeUndefined();
      expect(ci[0].waitingOn.runId).toBeUndefined();
    }
    expect(rows(26000).every(s => s.waitingOn === null)).toBe(true);
    expect(rows(28000).find(s => s.id === 'showcase-claude')).toMatchObject({ state: 'awaiting_permission', waitingOn: null });
    expect(rows(32000).find(s => s.id === 'showcase-claude')!.state).toBe('processing');
  });

  it('replays only fictional history with integer wire timestamps and a clean loop reset', () => {
    const final = frame(35500);
    const history = final.find(e => e.type === 'timeline_history')!.entries;
    expect(history).toHaveLength(showcaseStory.phases.length - 1);
    expect(history.every(e => Number.isSafeInteger(e.ts) && e.sessionId.startsWith('showcase-'))).toBe(true);
    expect(rows(35500).every(s => s.state === 'idle')).toBe(true);
    expect(rows(0)).toEqual([]);
    expect(frame(0)[0]).toMatchObject({ daemonPort: 19522, gatewayConnected: false, gatewayAvailable: false });
    expect(showcaseStory.durationMs).toBe(38000);
  });

  it('serves canonical connection/snapshot/pong on an isolated loopback listener and releases it', async () => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>(resolve => probe.close(() => resolve()));
    const child = spawn(process.execPath, ['scripts/appstore-demo-orchestrator.mjs', 'serve', '--showcase', '--port', String(port), '--epoch-ms', String(Date.now() - 17000)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let socket: WebSocket | undefined;
    try {
      // Use a released ephemeral loopback port, never a production daemon.
      const output = await new Promise<string>((resolve, reject) => {
        let text = '';
        const timer = setTimeout(() => reject(new Error('fixture did not start')), 5000);
        child.stdout!.on('data', data => { text += data; if (text.includes('recording scenario:')) { clearTimeout(timer); resolve(text); } });
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`fixture exited ${code}`)); });
      });
      const url = output.match(/ws:\/\/127\.0\.0\.1:\d+/)![0];
      const messages: any[] = [];
      socket = new WebSocket(url);
      socket.on('message', data => messages.push(JSON.parse(data.toString())));
      await once(socket, 'open');
      socket.send(JSON.stringify({ type: 'ping' }));
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('no canonical snapshot/pong')), 3000);
        const check = setInterval(() => {
          if (messages.some(m => m.type === 'pong') && messages.some(m => m.type === 'sessions_list')) { clearTimeout(timeout); clearInterval(check); resolve(); }
        }, 10);
      });
      expect(messages[0]).toMatchObject({ type: 'connection', status: 'connected' });
      expect(messages.find(m => m.type === 'sessions_list').sessions.filter(s => s.agentType === 'hermes')).toHaveLength(1);
      expect(messages.find(m => m.type === 'sessions_list').sessions.find(s => s.agentType === 'codex-cli').waitingOn.phase).toBe('running');
    } finally {
      socket?.terminate();
      child.kill('SIGTERM');
      if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
    }
  });
});
