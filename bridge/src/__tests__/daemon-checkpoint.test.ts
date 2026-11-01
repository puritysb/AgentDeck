import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutonomousPocketEngine } from '../pocket-autonomy.js';
import { OutboxIdempotencyLedger } from '../card-feed.js';
import { DaemonCheckpointStore, parseDaemonCheckpoint, stagePeerCheckpoint } from '../daemon-checkpoint.js';
const dirs: string[] = [];
const directory = () => { const dir = mkdtempSync(join(tmpdir(), 'checkpoint-')); dirs.push(dir); return dir; };
const engine = () => new AutonomousPocketEngine({ persist: false });
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe('local owner checkpoints', () => {
  it('consumes the common receipt and checkpoint vectors', () => {
    const vector = JSON.parse(readFileSync(new URL('../../../shared/daemon-checkpoint-vectors.json', import.meta.url), 'utf8'));
    const payload = parseDaemonCheckpoint(JSON.stringify(vector.checkpoint));
    expect(payload).not.toBeNull();
    for (const { decision, key } of vector.decisions) {
      const actual = new OutboxIdempotencyLedger(); actual.remember(decision, { cardId: decision.cardId, status: 'applied' });
      expect(actual.snapshot()[0].key).toBe(key);
    }
    const ledger = new OutboxIdempotencyLedger(); ledger.restore(payload!.receipts);
    expect(ledger.get(vector.decision)?.status).toBe('applied');
    for (const authority of vector.authorityCases) {
      const dir = directory();
      const own = new DaemonCheckpointStore(dir, engine(), new OutboxIdempotencyLedger());
      let reference = JSON.parse(own.capture());
      if (authority.withPeer) {
        const peer = new DaemonCheckpointStore(directory(), engine(), new OutboxIdempotencyLedger());
        expect(stagePeerCheckpoint(dir, peer.capture())).toBe(true); reference = JSON.parse(peer.capture());
      }
      const next = new DaemonCheckpointStore(dir, engine(), new OutboxIdempotencyLedger());
      expect(JSON.parse(next.capture()).lineage !== reference.lineage, authority.name).toBe(authority.newLineage);
    }
  });
  it('continues aggregate state and a response-loss receipt, preserving a different inactive profile', () => {
    const source = directory(), target = directory(), pocket = engine(), ledger = new OutboxIdempotencyLedger();
    const decision = { cardId: 'opaque:fixture', action: 'card_choice', choiceId: 'useful', text: 'private text / 한글', ageSec: 1 };
    pocket.adopt({ ...pocket.snapshot(), feedbackCount: 7 });
    ledger.remember(decision, { cardId: decision.cardId, status: 'applied' });
    const first = new DaemonCheckpointStore(source, pocket, ledger);
    const local = engine(); local.adopt({ ...local.snapshot(), feedbackCount: 3 });
    new DaemonCheckpointStore(target, local, new OutboxIdempotencyLedger());
    expect(stagePeerCheckpoint(target, first.capture(true))).toBe(true);
    const restored = new OutboxIdempotencyLedger(), next = new DaemonCheckpointStore(target, local, restored);
    expect(local.snapshot().feedbackCount).toBe(7);
    expect(restored.get({ ...decision, ageSec: 999 })).toEqual({ cardId: decision.cardId, status: 'applied' });
    expect(readdirSync(target).some(name => name.startsWith('daemon-checkpoint-profile-'))).toBe(true);
    expect(next.capture()).not.toContain('private text');
    expect(next.capture()).not.toContain(decision.cardId);
    expect(stagePeerCheckpoint(target, first.capture())).toBe(false);
    expect(next.acknowledgementSequence(first.id)).toBeNull();
    expect(next.acknowledgementSequence(next.id)).toBe(next.sequence);
    expect(next.acknowledgementSequence(next.id + '0')).toBeNull();
  });
  it('restarts an absent owner on a new authority branch without losing its receipts', () => {
    const dir = directory(), other = directory(), ledger = new OutboxIdempotencyLedger();
    ledger.remember({ cardId: 'saved', action: 'dismiss' }, { cardId: 'saved', status: 'applied' });
    const first = new DaemonCheckpointStore(dir, engine(), ledger), prior = JSON.parse(first.capture());
    expect(stagePeerCheckpoint(other, first.capture())).toBe(true);
    const promoted = new DaemonCheckpointStore(other, engine(), new OutboxIdempotencyLedger());
    expect(JSON.parse(promoted.capture()).generation).toBeGreaterThan(prior.generation);
    const restored = new OutboxIdempotencyLedger(), restarted = new DaemonCheckpointStore(dir, engine(), restored);
    expect(JSON.parse(restarted.capture()).lineage).not.toBe(prior.lineage);
    expect(restored.get({ cardId: 'saved', action: 'dismiss' })?.status).toBe('applied');
    expect(stagePeerCheckpoint(other, restarted.capture())).toBe(true);
  });
  it('rejects corrupt, oversize, lossy and unsafe counters without overwriting evidence', () => {
    const dir = directory(), store = new DaemonCheckpointStore(dir, engine(), new OutboxIdempotencyLedger());
    const raw = JSON.parse(store.capture());
    for (const bad of [{ ...raw, generation: -1 }, { ...raw, sequence: Number.MAX_SAFE_INTEGER },
      { ...raw, pocket: { ...raw.pocket, prompt: 'private' } }, { ...raw, receipts: [{ key: 'bad', status: 'applied' }] }]) {
      expect(parseDaemonCheckpoint(JSON.stringify(bad))).toBeNull();
    }
    expect(parseDaemonCheckpoint('x'.repeat(262145))).toBeNull();
    writeFileSync(join(dir, 'daemon-checkpoint.json'), '{corrupt');
    expect(() => new DaemonCheckpointStore(dir, engine(), new OutboxIdempotencyLedger())).toThrow('invalid');
    expect(readFileSync(join(dir, 'daemon-checkpoint.json'), 'utf8')).toBe('{corrupt');
  });
  it('fences old generations and sequences and retains every acknowledged receipt across restart', () => {
    const dir = directory(), peerDir = directory(), ledger = new OutboxIdempotencyLedger(), pocket = engine();
    const store = new DaemonCheckpointStore(dir, pocket, ledger), old = store.capture();
    ledger.remember({ cardId: 'one', action: 'dismiss' }, { cardId: 'one', status: 'applied' });
    const fresh = store.capture();
    expect(stagePeerCheckpoint(peerDir, fresh)).toBe(true);
    expect(stagePeerCheckpoint(peerDir, old)).toBe(false);
    expect(stagePeerCheckpoint(peerDir, fresh)).toBe(true);
    const restored = new OutboxIdempotencyLedger(); new DaemonCheckpointStore(peerDir, engine(), restored);
    expect(restored.get({ cardId: 'one', action: 'dismiss', ageSec: 5 })?.status).toBe('applied');
    expect(stagePeerCheckpoint(peerDir, fresh)).toBe(false);
  });
});
