import { describe, it, expect, vi } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { outputs } from '../../../scripts/generate-antigravity-observation.mjs';
import { observeAntigravityTranscript, scanAntigravityRoot } from '../antigravity-observation.js';
import { bindAntigravityOwners, collectAntigravitySessions, dedupeObservedSessions, PassiveSessionObserver } from '../passive-observer.js';

interface Vector { name: string; conversationId: string; raw: string; modifiedAtMs: number; nowMs: number }
const vectors = JSON.parse(readFileSync('shared/antigravity-observation-vectors.json', 'utf8')) as Vector[];
const observe = (v: Vector) => observeAntigravityTranscript(v.conversationId, v.raw, v.modifiedAtMs, v.nowMs);
function source(root: string, v: Vector) {
  const dir = join(root, 'brain', v.conversationId, '.system_generated', 'logs');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'transcript.jsonl'); writeFileSync(file, v.raw); utimesSync(file, v.modifiedAtMs / 1000, v.modifiedAtMs / 1000);
  return file;
}

describe('Antigravity evidence contract', () => {
  it.each([false, true])('publishes file evidence with an unknown process table (rejected=%s), expires its lease and refuses ambiguous PID ownership', async rejected => {
    const dir = mkdtempSync(join(tmpdir(), 'antigravity-lease-'));
    vi.useFakeTimers({ now: vectors[0].nowMs });
    try {
      source(dir, vectors[0]);
      const rows = await collectAntigravitySessions([dir], Date.now());
      bindAntigravityOwners(rows, [{ conversationId: vectors[0].conversationId, pid: 42 }]);
      expect(rows[0].pid).toBe(42);
      bindAntigravityOwners(rows, [{ conversationId: vectors[0].conversationId, pid: 42 }, { conversationId: vectors[0].conversationId, pid: 43 }]);
      expect(rows[0].pid).toBe(0);
      const observer = new PassiveSessionObserver(async () => { if (rejected) throw new Error('process probe unknown'); return []; }, undefined, undefined, async () => rows);
      observer.collect([]);
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(observer.collect([])).toHaveLength(1);
      vi.advanceTimersByTime(11 * 60_000);
      expect(observer.collect([])).toHaveLength(0);
    } finally { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('keeps the generated policy current', () => {
    for (const { path, expected } of outputs()) expect(readFileSync(path, 'utf8')).toBe(expected);
  });
  it('uses stable conversation/turn identities and never invents completion for stale/unknown evidence', () => {
    const byName = Object.fromEntries(vectors.map(v => [v.name, observe(v)]));
    expect(byName['fresh-running'].state).toBe('processing');
    expect(byName['duplicate-step-finish'].state).toBe('idle');
    expect(byName['fresh-running'].currentTurnId).toBe(byName['duplicate-step-finish'].currentTurnId);
    expect(byName['new-turn'].currentTurnId).not.toBe(byName['fresh-running'].currentTurnId);
    expect(byName['rotation-reused-index'].currentTurnId).not.toBe(byName['fresh-running'].currentTurnId);
    expect(byName['historical-running-then-done'].state).toBe('idle');
    for (const name of ['unknown-step', 'missing-time', 'partial-tail', 'unsupported-id', 'no-user-identity', 'boolean-index-last']) {
      expect(byName[name].status, name).toBe('unknown'); expect(byName[name].state, name).toBeUndefined();
    }
    for (const name of ['stale-running', 'ancient-source-touched', 'old-file-mtime']) {
      expect(byName[name].status, name).toBe('stale'); expect(byName[name].state, name).toBeUndefined();
    }
  });
  it('scans explicit sources without a process, ignores unreadable/symlinked records and keeps timestamps stable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'antigravity-source-'));
    try {
      source(dir, vectors[0]);
      mkdirSync(join(dir, 'cache')); writeFileSync(join(dir, 'cache', 'last_conversations.json'), JSON.stringify({ '/work/project': vectors[0].conversationId }));
      const first = await collectAntigravitySessions([dir], vectors[0].nowMs);
      expect(first).toHaveLength(1); expect(first[0].pid).toBe(0); expect(first[0].projectName).toBe('project');
      expect((await collectAntigravitySessions([dir], vectors[0].nowMs + 1000))[0].startedAt).toBe(first[0].startedAt);
      expect(dedupeObservedSessions(first, [{ ...first[0], id: vectors[0].conversationId }], [])).toHaveLength(0);
      const outside = join(dir, 'outside.jsonl'); writeFileSync(outside, vectors[0].raw);
      const file = join(dir, 'brain', vectors[0].conversationId, '.system_generated', 'logs', 'transcript.jsonl'); rmSync(file); symlinkSync(outside, file);
      expect(scanAntigravityRoot(dir, vectors[0].nowMs).observations[0].status).toBe('unknown');
      expect(await collectAntigravitySessions([dir], vectors[0].nowMs)).toHaveLength(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.skipIf(process.platform !== 'darwin')('executes the actual Swift parser and scoped reader against Node vectors and the same filesystem', () => {
    const dir = mkdtempSync(join(tmpdir(), 'antigravity-parity-'));
    try {
      const binary = join(dir, 'observer');
      execFileSync('swiftc', ['-module-cache-path', join(dir, 'modules'), '-parse-as-library',
        'apple/AgentDeck/Daemon/Session/AntigravityPolicy.generated.swift', 'apple/AgentDeck/Daemon/Session/AntigravityObservation.swift',
        'apple/AgentDeck/Daemon/Session/AntigravitySourceReader.swift', 'bridge/src/__tests__/fixtures/antigravity-observation-main.swift', '-o', binary], { timeout: 120000 });
      const native = JSON.parse(execFileSync(binary, { input: JSON.stringify(vectors), encoding: 'utf8', timeout: 15000 }));
      expect(native).toEqual(vectors.map(observe));
      source(dir, vectors[0]);
      const scan = JSON.parse(execFileSync(binary, [dir, String(vectors[0].nowMs)], { encoding: 'utf8', timeout: 15000 }));
      delete scan.projects;
      expect(scan).toEqual(scanAntigravityRoot(dir, vectors[0].nowMs));
      for (const hasNewUser of [true, false]) {
        const records = vectors[0].raw.trim().split('\n');
        const large = { ...vectors[0], raw: records[0] + '\n' + (JSON.stringify({ padding: 'x'.repeat(1000) }) + '\n').repeat(700)
          + (hasNewUser ? records[0] + '\n' : '') + records.at(-1) + '\n' };
        source(dir, large);
        const nativeScan = JSON.parse(execFileSync(binary, [dir, String(large.nowMs)], { encoding: 'utf8', timeout: 15000 }));
        delete nativeScan.projects;
        expect(nativeScan).toEqual(scanAntigravityRoot(dir, large.nowMs));
        expect(nativeScan.observations[0].status).toBe(hasNewUser ? 'known' : 'unknown');
      }
      for (const model of ['', 'fallback-model']) {
        const records = vectors[0].raw.trim().split('\n').map(line => JSON.parse(line));
        records[0].content = '<USER_REQUEST>Metadata fixture</USER_REQUEST>';
        source(dir, { ...vectors[0], raw: records.map(record => JSON.stringify(record)).join('\n') + '\n' });
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({ model }));
        const nativeScan = JSON.parse(execFileSync(binary, [dir, String(vectors[0].nowMs)], { encoding: 'utf8', timeout: 15000 }));
        delete nativeScan.projects;
        expect(nativeScan).toEqual(scanAntigravityRoot(dir, vectors[0].nowMs));
        expect(nativeScan.observations[0].model).toBe(model);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 150000);
});
