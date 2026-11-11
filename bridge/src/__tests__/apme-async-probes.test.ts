import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const io = vi.hoisted(() => ({ pending: [] as Array<{ file: string; args: string[]; done: (error: Error | null, output: string) => void }> }));
vi.mock('node:child_process', async original => ({
  ...await original<typeof import('node:child_process')>(),
  execFile: vi.fn((file, args, _options, done) => { io.pending.push({ file, args, done }); }),
}));
import { execFile } from 'node:child_process';
import { buildJudgePrompt, runDeterministic } from '../apme/runner.js';
import { ApmeHwSampler } from '../apme/hw-sampler.js';
import { computeEfficiency, evaluateOutcome } from '../apme/outcome.js';
import { DEFAULT_APME_CONFIG } from '../apme/settings.js';
import type { ApmeRunRow } from '../apme/types.js';
import type { ApmeStore } from '../apme/store.js';
const roots: string[] = [];
function project() { const root = mkdtempSync(join(tmpdir(), 'apme-async-')); roots.push(root); mkdirSync(join(root, 'Demo.xcodeproj')); return root; }
function run(root: string): ApmeRunRow { return { id: 'run', projectPath: root, agentType: 'claude-code', gitBefore: 'a', gitAfter: 'b', startedAt: 1000, endedAt: 5000 } as ApmeRunRow; }
afterEach(() => { io.pending.length = 0; vi.clearAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function timerBeats() { await new Promise(resolve => setTimeout(resolve, 0)); }
function finishSwiftDirectoryRead() {
  expect(io.pending[0].file).toBe(process.execPath);
  io.pending.shift()!.done(null, '["Demo.xcodeproj"]');
}
describe('APME background subprocess probes', () => {
  it('keeps timers running and skips deterministic checks when a protected directory read times out', async () => {
    const root = project();
    const result = runDeterministic(run(root), DEFAULT_APME_CONFIG);
    await timerBeats();
    expect(execFile).toHaveBeenCalledWith(process.execPath,
      ['--input-type=commonjs', '-e', expect.stringContaining('readdirSync'), '--', root],
      expect.objectContaining({ timeout: 3000, killSignal: 'SIGKILL' }), expect.any(Function));
    expect(vi.mocked(execFile).mock.calls[0][2]).not.toHaveProperty('cwd');
    io.pending.shift()!.done(Object.assign(new Error('directory read timed out'), { code: 'ETIMEDOUT' }), '');
    expect(await result).toEqual([]);
    expect(execFile).toHaveBeenCalledTimes(1);
  });
  it('yields while Xcode scheme discovery is pending', async () => {
    const result = runDeterministic(run(project()), DEFAULT_APME_CONFIG);
    await timerBeats();
    finishSwiftDirectoryRead();
    await timerBeats();
    expect(io.pending[0].file).toBe('xcodebuild');
    expect(execFile).toHaveBeenCalledWith('xcodebuild', expect.any(Array), expect.objectContaining({ timeout: 10_000, killSignal: 'SIGKILL' }), expect.any(Function));
    io.pending.shift()!.done(null, '{"project":{"schemes":[]}}');
    expect(await result).toEqual([]);
  });
  it('yields during dirty-worktree detection and skips clean projects', async () => {
    const row = run(project()); row.gitAfter = row.gitBefore;
    const result = runDeterministic(row, DEFAULT_APME_CONFIG);
    await timerBeats();
    finishSwiftDirectoryRead();
    await timerBeats();
    expect(io.pending[0].args).toEqual(['status', '--porcelain']);
    io.pending.shift()!.done(null, '');
    expect(await result).toEqual([]);
    expect(execFile).toHaveBeenCalledTimes(2);
  });
  it('builds the judge prompt after an asynchronous bounded diff', async () => {
    const result = buildJudgePrompt(run(project()), 'rubric', true);
    await timerBeats();
    expect(io.pending[0].args).toContain('--no-ext-diff');
    io.pending.shift()!.done(null, '+fixed');
    expect(await result).toContain('+fixed');
  });
  it('computes efficiency after the child completes', async () => {
    const result = computeEfficiency({ ...run(project()), inputTokens: 200, taskSignals: '{"totalToolCalls":2}' });
    await timerBeats();
    io.pending.shift()!.done(null, '1 file changed, 3 insertions(+), 2 deletions(-)');
    expect(await result).toMatchObject({ diffLines: 5, tokensPerChange: 40, toolEfficiency: 2.5 });
  });
  it('does not overwrite a newer outcome while Git is pending', async () => {
    const row = run(project());
    const store = { enabled: true, getRun: vi.fn(() => row), updateRun: vi.fn() } as unknown as ApmeStore;
    const result = evaluateOutcome(store, row.id);
    await timerBeats();
    store.getRun = vi.fn(() => ({ ...row, outcome: 'abandoned' }));
    io.pending.shift()!.done(null, '');
    expect(await result).toBeNull();
    expect(store.updateRun).not.toHaveBeenCalled();
  });
  it.runIf(process.platform === 'darwin')('coalesces concurrent hardware snapshots without blocking timers', async () => {
    const sampler = new ApmeHwSampler();
    const first = sampler.snapshot();
    expect(sampler.snapshot()).toBe(first);
    await timerBeats();
    expect(io.pending).toHaveLength(3);
    for (const probe of io.pending.splice(0)) {
      probe.done(null, probe.args[1] === 'hw.memsize' ? '16000' : probe.args[1] === 'hw.logicalcpu' ? '8' : 'MacTest');
    }
    await timerBeats();
    for (const probe of io.pending.splice(0)) {
      probe.done(null, probe.file === 'uptime' ? 'load averages: 2.0 1.0 1.0' : 'page size of 4096 bytes\nPages active: 2.\nPages wired down: 1.');
    }
    expect(await first).toMatchObject({ model: 'MacTest', memTotal: 16000, memUsed: 12288, cpuLoad: 0.25, cpuCount: 8 });
    expect(execFile).toHaveBeenCalledTimes(5);
  });
});
