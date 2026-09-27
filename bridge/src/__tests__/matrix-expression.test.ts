import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { MatrixExpression, MATRIX_RULES, type MatrixSession, type MatrixBroadcast, type BridgeEvent } from '@agentdeck/shared';
import { renderMatrixScene } from '../pixoo/matrix-art.js';
import { swiftMatrixSource } from '../../../scripts/generate-matrix-expressions.mts';
import { broadcastMatrix, getLastFrame, renderPreviewFrame } from '../pixoo/pixoo-bridge.js';

const row = (id: string, state = 'processing', agentType = 'claude-code', alive = true): MatrixSession => ({ id, state, agentType, alive });
afterEach(() => vi.useRealTimers());
describe('expressive BLE matrices', () => {
  it('keeps numeric information on the default world, with no creature carousel', () => {
    const engine = new MatrixExpression();
    engine.updateSessions([row('c'), row('x', 'idle', 'codex-cli')], 100);
    for (const now of [100, 9000, 30000]) {
      expect(engine.scene(now)).toMatchObject({ kind: 'working', glyph: 'summary', counts: [0, 1, 0, 2] });
    }
    expect(renderMatrixScene(32, engine.scene(100))).toEqual(renderMatrixScene(32, engine.scene(9000)));
  });
  it('earns a six-second entrance only for a new live session, independent of polls and order', () => {
    const engine = new MatrixExpression();
    engine.updateSessions([row('c')], 100);
    expect(engine.scene(100).glyph).toBe('summary');
    engine.updateSessions([row('x', 'processing', 'codex-cli'), row('c')], 200);
    expect(engine.scene(200)).toMatchObject({ kind: 'arrival', glyph: 'codex', count: 2 });
    engine.updateSessions([row('c'), row('x', 'processing', 'codex-cli')], 2000);
    expect(engine.scene(6200).glyph).toBe('summary');
    engine.updateSessions([row('c')], 6201);
    engine.updateSessions([row('c'), row('x')], 6202);
    expect(engine.scene(6202).kind).toBe('working');
    engine.reset(); engine.updateSessions([row('c'), row('x')], 6300);
    expect(engine.scene(6300).kind).toBe('working');
  });
  it('never hides waiting or errors behind a new creature or a response', () => {
    const engine = new MatrixExpression();
    engine.updateSessions([], 0);
    engine.updateSessions([row('c', 'awaiting_permission'), row('x', 'error')], 100);
    engine.updateTimeline([{ ts: 100, type: 'chat_response' }]);
    expect(engine.scene(100)).toMatchObject({ kind: 'waiting', glyph: 'summary', counts: [1, 0, 1, 1] });
    expect(renderMatrixScene(32, engine.scene(100))).not.toEqual(renderMatrixScene(32, engine.scene(1000)));
  });
  it('shows an actual response briefly, retains its count for 90s, and distinguishes unknown and idle', () => {
    const engine = new MatrixExpression();
    expect(engine.scene(0).kind).toBe('unknown');
    engine.updateSessions([row('c'), row('x', 'idle', 'codex-cli')], 0);
    engine.updateTimeline([{ ts: 100, type: 'chat_response', sessionId: 'x' }]);
    expect(engine.scene(100)).toMatchObject({ kind: 'done', glyph: 'codex', counts: [0, 1, 1, 2] });
    for (let i = 0; i < 120; i++) engine.ingest({ type: 'timeline_event', entry: { ts: 101 + i, type: 'tool_exec' } }, 500);
    expect(engine.scene(500).count).toBe(1);
    expect(engine.scene(6100)).toMatchObject({ kind: 'done', glyph: 'summary' });
    expect(engine.scene(90100)).toMatchObject({ kind: 'working', counts: [0, 1, 0, 2] });
    engine.updateSessions([], 90101);
    expect(engine.scene(90101).kind).toBe('idle');
  });
  it('unknown agent identities are neutral, and face expressions survive 4-bit packing', () => {
    const engine = new MatrixExpression(); engine.updateSessions([], 0);
    engine.updateSessions([row('future', 'processing', 'future-agent')], 100);
    expect(engine.scene(100).glyph).toBe('neutral');
    const signatures = new Set<string>();
    for (const kind of ['working', 'waiting', 'error', 'done', 'idle', 'unknown'] as const) {
      const pixels = renderMatrixScene(11, { ...engine.scene(100), kind });
      const packed = pixels.map(n => Math.round(n / 17));
      expect(packed.some(n => n > 0)).toBe(true);
      signatures.add(Buffer.from(packed).toString('base64'));
    }
    expect(signatures.size).toBe(6);
  });
  it('routes live Node endpoint frames through the same event state (preview does not replay entrances)', () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const send = (event: unknown) => broadcastMatrix(event as BridgeEvent);
    send({ type: 'connection', status: 'disconnected' });
    send({ type: 'sessions_list', sessions: [row('c')] });
    const baseline = getLastFrame(32);
    send({ type: 'sessions_list', sessions: [row('c'), row('x', 'processing', 'codex-cli')] });
    expect(getLastFrame(32)).not.toEqual(baseline);
    expect(renderPreviewFrame(32)).toEqual(getLastFrame(32));
    vi.setSystemTime(10000 + MATRIX_RULES.arrivalMs);
    const settled = getLastFrame(32);
    expect(renderPreviewFrame(32)).toEqual(settled);
    expect(fs.readFileSync('bridge/src/daemon-server.ts', 'utf8')).toContain('core.wsServer.onBroadcast(broadcastMatrix)');
    send({ type: 'connection', status: 'disconnected' });
    expect(getLastFrame(11)).not.toEqual(baseline);
  });
  it('has no generated policy or pixel drift', () => {
    expect(fs.readFileSync('apple/AgentDeck/Daemon/Modules/MatrixFrames.generated.swift', 'utf8')).toBe(swiftMatrixSource());
  });
  it.runIf(process.platform === 'darwin')('executes the Swift engine and matches Node state and every output pixel', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-parity-'));
    try {
      const exe = path.join(temp, 'parity');
      execFileSync('xcrun', ['swiftc', 'apple/AgentDeck/Daemon/Modules/MatrixFrames.generated.swift',
        'apple/AgentDeck/Daemon/Modules/MatrixExpression.swift', 'scripts/matrix-expression-parity.swift', '-o', exe], { timeout: 120000 });
      const steps: { now: number; event?: Record<string, unknown> }[] = [{ now: 0 }];
      const add = (now: number, event?: Record<string, unknown>) => steps.push({ now, event });
      add(1, { type: 'sessions_list', sessions: [] });
      add(100, { type: 'sessions_list', sessions: [row('c'), row('x', 'idle', 'codex-cli')] });
      for (let frame = 0; frame < 9; frame++) add(100 + frame * 750);
      add(10000, { type: 'sessions_list', sessions: [row('c', 'awaiting_option'), row('x', 'error', 'codex-cli')] });
      for (let frame = 0; frame < 8; frame++) add(10000 + frame * 750);
      add(17000, { type: 'sessions_list', sessions: [row('c', 'error'), row('x', 'idle', 'codex-cli')] });
      add(18000, { type: 'sessions_list', sessions: [row('c'), row('x', 'idle', 'codex-cli')] });
      add(18000, { type: 'timeline_event', entry: { ts: 18000, type: 'chat_response', sessionId: 'x' } });
      for (let frame = 0; frame < 9; frame++) add(18000 + frame * 750);
      for (let i = 0; i < 120; i++) add(24000, { type: 'timeline_event', entry: { ts: 19000 + i, type: 'tool_exec' } });
      add(24001, { type: 'usage_update', fiveHourPercent: 100 });
      add(24002, { type: 'timeline_event', upsert: true, entry: { ts: 18000, type: 'chat_response', sessionId: 'x', status: 'abandoned' } });
      add(24003, { type: 'timeline_history', entries: [{ ts: 24000, type: 'task_end' }, { ts: 99000, type: 'chat_response' }] });
      add(120000); add(120001, { type: 'connection', status: 'disconnected' });
      add(120002, { type: 'sessions_list', sessions: [row('c', 'idle')] });
      add(120003, { type: 'sessions_list', sessions: [row('c', 'idle'), row('f', 'processing', 'future')] });
      add(126003); add(126004, { type: 'sessions_list', sessions: Array.from({ length: 103 }, (_, i) => row(String(i), i === 0 ? 'awaiting_diff' : 'processing')) });
      const engine = new MatrixExpression();
      const expected = steps.map(({ now, event }) => {
        if (event) engine.ingest(event as MatrixBroadcast, now);
        const scene = engine.scene(now);
        return { kind: scene.kind, count: scene.count, glyph: scene.glyph, counts: scene.counts,
          face: Buffer.from(renderMatrixScene(11, scene)).toString('base64'), world: Buffer.from(renderMatrixScene(32, scene)).toString('base64') };
      });
      const actual = JSON.parse(execFileSync(exe, { input: JSON.stringify(steps), maxBuffer: 4 * 1024 * 1024 }).toString());
      expect(actual).toEqual(expected);
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  }, 150000);
});
