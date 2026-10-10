import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { MatrixExpression, MATRIX_RULES, MATRIX_FACES, type MatrixSession, type MatrixBroadcast, type BridgeEvent } from '@agentdeck/shared';
import { renderMatrixScene, renderMatrixFace } from '../pixoo/matrix-art.js';
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
    expect(engine.scene(100)).toMatchObject({ kind: 'waiting', glyph: 'claudeCode', counts: [1, 0, 1, 1] });
    expect(renderMatrixScene(32, engine.scene(100))).not.toEqual(renderMatrixScene(32, engine.scene(1000)));
  });
  it('holds a reply on stage briefly, retains its count for 90s, and distinguishes unknown and idle', () => {
    const engine = new MatrixExpression();
    expect(engine.scene(0).kind).toBe('unknown');
    engine.updateSessions([row('c'), row('x', 'idle', 'codex-cli')], 0);
    engine.updateTimeline([{ ts: 100, type: 'chat_response', sessionId: 'x' }]);
    expect(engine.scene(100)).toMatchObject({ kind: 'reply', glyph: 'codex', counts: [0, 1, 1, 2] });
    for (let i = 0; i < 120; i++) engine.ingest({ type: 'timeline_event', entry: { ts: 101 + i, type: 'tool_exec' } }, 500);
    expect(engine.scene(5100)).toMatchObject({ kind: 'reply', glyph: 'codex' });
    expect(engine.scene(6100)).toMatchObject({ kind: 'done', glyph: 'summary', count: 1 });
    expect(engine.scene(90100)).toMatchObject({ kind: 'working', counts: [0, 1, 0, 2] });
    engine.updateSessions([], 90101);
    expect(engine.scene(90101).kind).toBe('idle');
  });
  it('keeps the asked agent listening until its reply, and a task close is not a conversation', () => {
    const engine = new MatrixExpression();
    engine.updateSessions([row('o', 'processing', 'openclaw'), row('c')], 0);
    engine.ingest({ type: 'timeline_event', entry: { ts: 1000, type: 'chat_start', sessionId: 'o' } }, 1000);
    expect(engine.scene(1000)).toMatchObject({ kind: 'asked', glyph: 'openClaw' });
    expect(engine.scene(1000 + MATRIX_RULES.askMs - 1)).toMatchObject({ kind: 'asked', glyph: 'openClaw' });
    // A long turn reads as work, not as a standing question.
    expect(engine.scene(1000 + MATRIX_RULES.askMs)).toMatchObject({ kind: 'working', glyph: 'summary' });
    engine.ingest({ type: 'timeline_event', entry: { ts: 130000, type: 'chat_response', sessionId: 'o' } }, 130000);
    expect(engine.scene(130000)).toMatchObject({ kind: 'reply', glyph: 'openClaw' });
    expect(engine.scene(176000).kind).toBe('done');
    // An automated turn (a cron) and a bare task close stay off the stage.
    const quiet = new MatrixExpression();
    quiet.updateSessions([row('o', 'processing', 'openclaw')], 0);
    quiet.ingest({ type: 'timeline_event', entry: { ts: 10, type: 'chat_start', sessionId: 'o', automated: true } }, 10);
    expect(quiet.scene(10).kind).toBe('working');
    quiet.ingest({ type: 'timeline_event', entry: { ts: 20, type: 'chat_response', sessionId: 'o', automated: true } }, 20);
    quiet.ingest({ type: 'timeline_event', entry: { ts: 30, type: 'task_end', sessionId: 'o' } }, 30);
    expect(quiet.scene(7000)).toMatchObject({ kind: 'done', glyph: 'summary' });
    // A question to a session that is gone is not held open, and needs-you still wins.
    quiet.ingest({ type: 'timeline_event', entry: { ts: 8000, type: 'chat_start', sessionId: 'gone' } }, 8000);
    expect(quiet.scene(8000).kind).not.toBe('asked');
    engine.updateSessions([row('o', 'awaiting_permission', 'openclaw')], 131000);
    expect(engine.scene(131000).kind).toBe('waiting');
  });
  it('matches rows to roster sessions across id forms (observed prefix, OpenClaw Gateway presence)', () => {
    const uuid = '4ba825fc-72de-485d-9aef-8284ddfd97ce';
    const engine = new MatrixExpression();
    engine.updateSessions([row(`observed:claude:${uuid}`), row('openclaw-gateway', 'processing', 'openclaw')], 0);
    // Observed: the roster is prefixed, the rows are the bare uuid.
    engine.ingest({ type: 'timeline_event', entry: { ts: 10, type: 'chat_start', sessionId: uuid, agentType: 'claude-code' } }, 10);
    expect(engine.scene(10)).toMatchObject({ kind: 'asked', glyph: 'claudeCode' });
    engine.ingest({ type: 'timeline_event', entry: { ts: 20, type: 'chat_response', sessionId: uuid, agentType: 'claude-code' } }, 20);
    expect(engine.scene(20)).toMatchObject({ kind: 'reply', glyph: 'claudeCode' });
    // OpenClaw rows carry per-agent keys; the roster has one Gateway presence.
    const claw = new MatrixExpression();
    claw.updateSessions([row('openclaw-gateway', 'processing', 'openclaw')], 0);
    claw.ingest({ type: 'timeline_event', entry: { ts: 10, type: 'chat_start', sessionId: 'openclaw:agent:main:main', agentType: 'openclaw' } }, 10);
    expect(claw.scene(10)).toMatchObject({ kind: 'asked', glyph: 'openClaw' });
    claw.ingest({ type: 'timeline_event', entry: { ts: 20, type: 'task_end', sessionId: 'openclaw:agent:main:main', agentType: 'openclaw' } }, 20);
    expect(claw.scene(20)).toMatchObject({ kind: 'done', glyph: 'openClaw' });
    // A result whose session already left keeps the creature its row names.
    const gone = new MatrixExpression();
    gone.updateSessions([row('c', 'idle')], 0);
    gone.ingest({ type: 'timeline_event', entry: { ts: 10, type: 'task_end', sessionId: 'left', agentType: 'codex-cli' } }, 10);
    expect(gone.scene(10)).toMatchObject({ kind: 'done', glyph: 'codex' });
    // An unknown agent on a row is still neutral, never another agent.
    gone.ingest({ type: 'timeline_event', entry: { ts: 30, type: 'task_end', sessionId: 'left2', agentType: 'future-agent' } }, 30);
    expect(gone.scene(30)).toMatchObject({ kind: 'done', glyph: 'neutral' });
  });
  it('rotates only the live attention owners and clears attention immediately', () => {
    const engine = new MatrixExpression();
    engine.updateSessions([row('a', 'awaiting_permission'), row('b', 'awaiting_option', 'codex-cli'), row('c')], 0);
    expect(engine.scene(0)).toMatchObject({ kind: 'waiting', glyph: 'claudeCode', count: 2 });
    expect(engine.scene(MATRIX_RULES.attentionMs)).toMatchObject({ glyph: 'codex' });
    engine.updateSessions([row('a', 'idle'), row('b', 'idle', 'codex-cli'), row('c')], 7000);
    expect(engine.scene(7000)).toMatchObject({ kind: 'working', glyph: 'summary' });
  });
  it('does not keep a historical conversation over a new turn, closed turn or missing roster', () => {
    const engine = new MatrixExpression();
    const event = (ts: number, type: string, sessionId = 'c') => engine.ingest({ type: 'timeline_event', entry: { ts, type, sessionId } }, ts);
    event(1, 'chat_response');
    expect(engine.scene(2).kind).toBe('unknown');
    engine.updateSessions([row('c')], 2);
    event(3, 'chat_start');
    expect(engine.scene(3).kind).toBe('asked');
    event(4, 'chat_end');
    expect(engine.scene(4).kind).not.toBe('asked');
    event(5, 'chat_start');
    engine.updateSessions([row('c', 'idle')], 6);
    expect(engine.scene(6).kind).not.toBe('asked');
    event(7, 'chat_response');
    engine.updateSessions([], 8);
    expect(engine.scene(8).kind).not.toBe('reply');
  });
  it('upserts one session without retracting another result at the same timestamp', () => {
    const engine = new MatrixExpression();
    engine.updateSessions([row('a'), row('b')], 0);
    for (const sessionId of ['a', 'b']) engine.ingest({ type: 'timeline_event', entry: { ts: 1, type: 'chat_response', sessionId } }, 1);
    engine.ingest({ type: 'timeline_event', upsert: true, entry: { ts: 1, type: 'chat_response', sessionId: 'b', status: 'abandoned' } }, 2);
    expect(engine.scene(2).counts[2]).toBe(1);
    engine.ingest({ type: 'timeline_event', upsert: true, entry: { ts: 1, type: 'chat_response', sessionId: 'a', status: 'abandoned' } }, 3);
    expect(engine.scene(3).counts[2]).toBe(0);
  });
  it('unknown agent identities are neutral, and face expressions survive 4-bit packing', () => {
    const engine = new MatrixExpression(); engine.updateSessions([], 0);
    engine.updateSessions([row('future', 'processing', 'future-agent')], 100);
    expect(engine.scene(100).glyph).toBe('neutral');
    const signatures = new Set<string>();
    for (const kind of ['working', 'waiting', 'error', 'done', 'idle', 'unknown', 'asked', 'reply'] as const) {
      const pixels = renderMatrixScene(11, { ...engine.scene(100), kind, face: undefined, pips: 0 });
      const packed = pixels.map(n => Math.round(n / 17));
      expect(packed.some(n => n > 0)).toBe(true);
      signatures.add(Buffer.from(packed).toString('base64'));
    }
    expect(signatures.size).toBe(8);
  });
  it('gives every Timebox face its own 4-bit signature in every frame', () => {
    for (let frame = 0; frame < MATRIX_RULES.frames; frame++) {
      const signatures = new Set(MATRIX_FACES.map(face =>
        Buffer.from(renderMatrixFace(face, frame).map(n => Math.round(n / 17))).toString('base64')));
      expect(signatures.size).toBe(MATRIX_FACES.length);
    }
    // Only needs-you faces change brightness between frames (the only pulse).
    for (const face of MATRIX_FACES) {
      const peak = (frame: number) => Math.max(...renderMatrixFace(face, frame));
      if (!['waiting', 'choosing', 'reviewing'].includes(face)) expect(peak(1)).toBe(peak(0));
    }
  });
  it('keeps speaking mouth shapes distinct at both phases of a 1.5 s BLE poll', () => {
    for (const phase of [0, 1]) {
      const mouths = Array.from({ length: 4 }, (_, i) =>
        Buffer.from(renderMatrixFace('reply', phase + i * 2).slice(7 * 11 * 3, 10 * 11 * 3)
          .map(n => Math.round(n / 17))).toString('base64'));
      expect(new Set(mouths).size).toBe(4);
    }
  });
  it('nods on a message, keeps accents visible after packing, and keeps the bottom row clear', () => {
    const engine = new MatrixExpression();
    engine.updateSessions([row('c')], 0);
    engine.ingest({ type: 'timeline_event', entry: { ts: 100, type: 'chat_start', sessionId: 'c' } }, 100);
    const before = renderMatrixScene(11, engine.scene(100));
    const nod = renderMatrixScene(11, engine.scene(100 + 2 * MATRIX_RULES.frameMs));
    const at = (pixels: Uint8Array, x: number, y: number) => pixels.slice((y * 11 + x) * 3, (y * 11 + x + 1) * 3);
    expect(at(before, 5, 8).some(n => n > 0)).toBe(true);
    expect(at(nod, 5, 8).every(n => n === 0)).toBe(true);
    expect(at(nod, 5, 9)).toEqual(at(before, 5, 8));
    // A warm cheek and the cyan eye must not collapse to one packed colour.
    for (const brightness of [1, .6]) {
      const packed = before.map(n => Math.round(n * brightness / 17));
      expect(at(packed, 1, 7)[0]).toBeGreaterThan(at(packed, 1, 7)[1]);
      expect(at(packed, 2, 3)[0]).toBeLessThan(at(packed, 2, 3)[1]);
    }
    for (const face of MATRIX_FACES) for (let frame = 0; frame < MATRIX_RULES.frames; frame++) {
      expect(renderMatrixFace(face, frame).slice(10 * 11 * 3).every(n => n === 0)).toBe(true);
      expect(renderMatrixFace(face, frame + MATRIX_RULES.frames)).toEqual(renderMatrixFace(face, frame));
    }
  });
  it('selects the face from more of the desk than the 32x32 kind', () => {
    const face = (sessions: MatrixSession[], now = 100, setup?: (e: MatrixExpression) => void) => {
      const engine = new MatrixExpression(); engine.updateSessions(sessions, 0); setup?.(engine);
      const { face, pips } = engine.scene(now); return { face, pips };
    };
    expect(new MatrixExpression().scene(0).face).toBe('unknown');
    // An empty roster is not an idle one.
    expect(face([])).toEqual({ face: 'empty', pips: 0 });
    expect(face([row('a', 'idle'), row('b', 'idle')])).toEqual({ face: 'idle', pips: 2 });
    // Population metadata follows the selected face, without drawing count dots.
    expect(face([row('a')])).toEqual({ face: 'working', pips: 1 });
    expect(face([row('a'), row('b', 'processing', 'codex-cli'), row('c', 'idle')])).toEqual({ face: 'working', pips: 2 });
    // Each needs-you state has its own face, in a fixed (not rotating) order.
    expect(face([row('a', 'awaiting_diff'), row('b', 'awaiting_option')])).toEqual({ face: 'choosing', pips: 2 });
    expect(face([row('a', 'awaiting_diff'), row('b', 'awaiting_permission')], 6000)).toEqual({ face: 'waiting', pips: 2 });
    expect(face([row('a', 'awaiting_diff')])).toEqual({ face: 'reviewing', pips: 1 });
    expect(face([row('a', 'awaiting_future')]).face).toBe('waiting');
    // A CI wait is neither PERM nor WORKING; it needs explicit agentWaiting, and unknown is its own face.
    const ci = (phase: string, agentWaiting?: boolean): MatrixSession => ({ ...row('c'), waitingOn: { phase, agentWaiting } });
    expect(face([ci('running', true)])).toEqual({ face: 'ci', pips: 1 });
    expect(face([ci('queued', true), ci('unknown', true)])).toEqual({ face: 'ci', pips: 2 });
    expect(face([ci('unknown', true)]).face).toBe('ci-unknown');
    expect(face([ci('running')]).face).toBe('working');
    expect(face([ci('passed', true)]).face).toBe('working');
    expect(face([ci('running', true), row('w')])).toEqual({ face: 'working', pips: 1 });
    expect(face([{ ...ci('running', true), state: 'awaiting_permission' }]).face).toBe('waiting');
    // Children working under an idle parent are work, not idleness.
    expect(face([{ ...row('p', 'idle'), subagents: { active: 3 } }])).toEqual({ face: 'delegating', pips: 3 });
    expect(face([{ ...row('p', 'idle'), subagents: { active: 0 } }]).face).toBe('idle');
    expect(face([{ ...row('p', 'idle'), subagents: { active: 2 } }, ci('running', true)]).face).toBe('delegating');
    // Gateway health is an error only while the daemon emits the OpenClaw session.
    const gateway = (e: MatrixExpression) => e.ingest({ type: 'state_update', gatewayHasError: true }, 50);
    expect(face([row('o', 'idle', 'openclaw')], 100, gateway)).toEqual({ face: 'error', pips: 1 });
    expect(face([row('c', 'idle')], 100, gateway).face).toBe('idle');
    expect(face([row('o', 'error', 'openclaw')], 100, gateway)).toEqual({ face: 'error', pips: 1 });
    expect(face([row('o', 'idle', 'openclaw')], 100, e => { gateway(e); e.ingest({ type: 'state_update' }, 60); }).face).toBe('error');
    expect(face([row('o', 'idle', 'openclaw')], 100, e => { gateway(e); e.ingest({ type: 'state_update', gatewayHasError: false }, 60); }).face).toBe('idle');
  });
  it('lets live work replace a result smile after the response window', () => {
    const engine = new MatrixExpression();
    engine.updateSessions([row('a'), row('b', 'idle')], 0);
    engine.updateTimeline([{ ts: 100, type: 'task_end', sessionId: 'b' }]);
    expect(engine.scene(200)).toMatchObject({ kind: 'done', face: 'done' });
    // The 32x32 keeps its 90 s result count; the face returns to the work.
    expect(engine.scene(100 + MATRIX_RULES.responseMs)).toMatchObject({ kind: 'done', face: 'working' });
    engine.updateSessions([row('a', 'idle'), row('b', 'idle')], 20000);
    expect(engine.scene(20000).face).toBe('done');
    expect(engine.scene(100 + MATRIX_RULES.resultMs).face).toBe('idle');
  });
  it('keeps the face independent of population count, including delegated children', () => {
    const engine = new MatrixExpression();
    engine.updateSessions([row('c')], 0);
    const base = engine.scene(0);
    for (const face of MATRIX_FACES) for (const pips of [0, 1, 2, 5, 99]) {
      expect(renderMatrixScene(11, { ...base, face, pips })).toEqual(renderMatrixFace(face, base.frame));
    }
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
      execFileSync('xcrun', ['swiftc', 'apple/AgentDeck/Model/ObservedAgentRules.generated.swift',
        'apple/AgentDeck/Daemon/Modules/MatrixFrames.generated.swift',
        'apple/AgentDeck/Daemon/Dot/DotRules.generated.swift', 'apple/AgentDeck/Model/DotSurface.generated.swift',
        'apple/AgentDeck/Model/DotPixels.generated.swift', 'apple/AgentDeck/Daemon/Modules/MatrixExpression.swift', 'scripts/matrix-expression-parity.swift', '-o', exe], { timeout: 120000 });
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
      add(100000, { type: 'sessions_list', sessions: [row('c'), row('o', 'processing', 'openclaw')] });
      add(100001, { type: 'timeline_event', entry: { ts: 100001, type: 'chat_start', sessionId: 'o' } });
      for (let frame = 0; frame < 9; frame++) add(100001 + frame * 750);
      add(110000, { type: 'timeline_event', entry: { ts: 110000, type: 'chat_response', sessionId: 'o' } });
      for (let frame = 0; frame < 9; frame++) add(110000 + frame * 750);
      add(110500, { type: 'timeline_event', entry: { ts: 110500, type: 'chat_start', sessionId: 'c', automated: true } });
      add(119999);
      add(120000); add(120001, { type: 'connection', status: 'disconnected' });
      add(120002, { type: 'sessions_list', sessions: [row('c', 'idle')] });
      add(120003, { type: 'sessions_list', sessions: [row('c', 'idle'), row('f', 'processing', 'future')] });
      add(126003); add(126004, { type: 'sessions_list', sessions: Array.from({ length: 103 }, (_, i) => row(String(i), i === 0 ? 'awaiting_diff' : 'processing')) });
      add(130000, { type: 'sessions_list', sessions: [row('a', 'awaiting_option'), row('b', 'awaiting_permission', 'codex-cli')] });
      add(136000);
      add(140000, { type: 'sessions_list', sessions: [row('a')] });
      add(140001, { type: 'timeline_event', entry: { ts: 140001, type: 'chat_response', sessionId: 'a' } });
      add(140002, { type: 'timeline_event', entry: { ts: 140002, type: 'chat_start', sessionId: 'a' } });
      add(140003, { type: 'timeline_event', entry: { ts: 140003, type: 'chat_end', sessionId: 'a' } });
      add(140004, { type: 'sessions_list', sessions: [] });
      // Timebox face inputs: CI waits, children, Gateway health, needs-you kinds, an empty roster.
      add(150000, { type: 'sessions_list', sessions: [{ ...row('c'), waitingOn: { phase: 'running', agentWaiting: true } },
        { ...row('k', 'idle'), waitingOn: { phase: 'unknown', agentWaiting: true } }] });
      add(150750);
      add(151000, { type: 'sessions_list', sessions: [{ ...row('c', 'idle'), waitingOn: { phase: 'unknown', agentWaiting: true } }, row('d', 'idle')] });
      add(152000, { type: 'sessions_list', sessions: [{ ...row('c', 'idle'), subagents: { active: 7, peak: 7, completed: 0 } }, row('d', 'idle')] });
      add(153000, { type: 'sessions_list', sessions: [{ ...row('c', 'idle'), subagents: { active: 0, peak: 7, completed: 7 } }, row('o', 'idle', 'openclaw')] });
      add(153001, { type: 'state_update', state: 'idle', gatewayHasError: true });
      add(153002, { type: 'state_update', state: 'idle' });
      add(153003, { type: 'state_update', state: 'idle', gatewayHasError: false });
      add(154000, { type: 'sessions_list', sessions: [row('a', 'awaiting_diff'), row('b', 'awaiting_option'), row('c'), row('d'), row('e')] });
      add(154750);
      add(155000, { type: 'sessions_list', sessions: [row('a', 'awaiting_diff'), row('c'), row('d')] });
      add(156000, { type: 'sessions_list', sessions: [row('c'), row('d'), row('e'), row('f'), row('g'), row('h'), row('i')] });
      add(157000, { type: 'sessions_list', sessions: [] });
      // Two id forms: an observed (prefixed) roster with bare-uuid rows, the
      // OpenClaw Gateway presence with per-agent row keys, and a departed row.
      add(160000, { type: 'sessions_list', sessions: [row('observed:claude:u1'), row('openclaw-gateway', 'processing', 'openclaw')] });
      add(160001, { type: 'timeline_event', entry: { ts: 160001, type: 'chat_start', sessionId: 'u1', agentType: 'claude-code' } });
      add(160751); add(160001 + MATRIX_RULES.askMs);
      add(230000, { type: 'timeline_event', entry: { ts: 230000, type: 'chat_response', sessionId: 'u1', agentType: 'claude-code' } });
      add(240000, { type: 'timeline_event', entry: { ts: 240000, type: 'chat_start', sessionId: 'openclaw:agent:main:main', agentType: 'openclaw' } });
      add(250000, { type: 'timeline_event', entry: { ts: 250000, type: 'task_end', sessionId: 'openclaw:agent:main:main', agentType: 'openclaw' } });
      add(260000, { type: 'timeline_event', entry: { ts: 260000, type: 'task_end', sessionId: 'left', agentType: 'codex-cli' } });
      const engine = new MatrixExpression();
      const expected = steps.map(({ now, event }) => {
        if (event) engine.ingest(event as MatrixBroadcast, now);
        const scene = engine.scene(now);
        return { kind: scene.kind, count: scene.count, glyph: scene.glyph, faceKind: scene.face, pips: scene.pips, counts: scene.counts,
          face: Buffer.from(renderMatrixScene(11, scene)).toString('base64'), world: Buffer.from(renderMatrixScene(32, scene)).toString('base64') };
      });
      const actual = JSON.parse(execFileSync(exe, { input: JSON.stringify(steps), maxBuffer: 4 * 1024 * 1024 }).toString());
      expect(actual).toEqual(expected);
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  }, 150000);
});
