import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('child_process', async (original) => ({ ...await original<typeof import('child_process')>(), spawn: mocks.spawn }));
vi.mock('os', async (original) => ({ ...await original<typeof import('os')>(), release: () => '25.0.0' }));
import { callFoundationModelsHelper, synthesizeWavWithHelper, clearFoundationModelsHelperForTests, stopFoundationModelsHelper } from '../foundation-models-helper.js';

class Child extends EventEmitter {
  killed = false;
  stdout = new PassThrough();
  stderr = new PassThrough();
  messages: Array<{ id: number; type: string }> = [];
  stdin = { write: (line: string, cb: (error?: Error) => void) => { this.messages.push(JSON.parse(line)); cb(); return true; } };
  kill = vi.fn(() => { this.killed = true; return true; });
  reply(payload: Record<string, unknown> = {}) {
    this.stdout.write(JSON.stringify({ id: this.messages.at(-1)!.id, ...payload }) + '\n');
  }
}
const children: Child[] = [];
let dir: string;
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeAll(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  dir = mkdtempSync(join(tmpdir(), 'agentdeck-speech-worker-'));
  const macho = Buffer.alloc(32); macho.writeUInt32LE(0xfeedfacf, 0);
  macho.writeUInt32LE(process.arch === 'arm64' ? 0x0100000c : 0x01000007, 4);
  writeFileSync(join(dir, 'helper'), macho);
});
afterAll(() => { Object.defineProperty(process, 'platform', platform); rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => {
  clearFoundationModelsHelperForTests(); children.length = 0;
  vi.stubEnv('AGENTDECK_FM_HELPER', join(dir, 'helper'));
  mocks.spawn.mockImplementation(() => { const child = new Child(); children.push(child); return child; });
});
afterEach(() => { stopFoundationModelsHelper(); vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('speech worker isolation and recovery', () => {
  it('synthesizes while a model request is still blocked', async () => {
    const judge = callFoundationModelsHelper('instructions', 'prompt');
    let judgeDone = false; void judge.then(() => { judgeDone = true; });
    const speech = synthesizeWavWithHelper('짧은 답변입니다.', '/tmp/reply.wav');
    expect(children).toHaveLength(2);
    expect(children[0].messages[0].type).toBe('generate');
    expect(children[1].messages[0].type).toBe('synthesize');
    children[1].reply({ wav: '/tmp/reply.wav', sampleRate: 16000, durationMs: 1000 });
    await expect(speech).resolves.toMatchObject({ durationMs: 1000 });
    expect(judgeDone).toBe(false);
    children[0].reply({ text: 'judged' }); await expect(judge).resolves.toBe('judged');
  });

  it('kills only a stuck speech worker and ignores its late exit after replacement', async () => {
    vi.useFakeTimers();
    const judge = callFoundationModelsHelper('instructions', 'prompt');
    const stuck = synthesizeWavWithHelper('test', '/tmp/stuck.wav');
    const rejected = expect(stuck).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(10_000); await rejected;
    expect(children[1].kill).toHaveBeenCalledWith('SIGKILL');
    expect(children[0].kill).not.toHaveBeenCalled();
    const next = synthesizeWavWithHelper('next', '/tmp/next.wav');
    expect(children).toHaveLength(3);
    children[1].emit('exit', null, 'SIGKILL');
    children[1].reply({ error: 'stale' });
    children[2].reply({ wav: '/tmp/next.wav' });
    await expect(next).resolves.toMatchObject({ wav: '/tmp/next.wav' });
    children[0].reply({ text: 'unaffected' }); await expect(judge).resolves.toBe('unaffected');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops and rejects both workers on daemon shutdown', async () => {
    const judge = callFoundationModelsHelper('instructions', 'prompt');
    const speech = synthesizeWavWithHelper('test', '/tmp/test.wav');
    const a = expect(judge).rejects.toThrow('stopped');
    const b = expect(speech).rejects.toThrow('stopped');
    stopFoundationModelsHelper(); await a; await b;
    expect(children.every(child => child.killed)).toBe(true);
  });
});
