/** Same-machine continuity: aggregate Pocket state and opaque Outbox receipts.
 * Credentials, source grants, card text and queued commands never enter here.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DAEMON_CHECKPOINT_POLICY as P } from '@agentdeck/shared';
import { AutonomousPocketEngine } from './pocket-autonomy.js';
import { OutboxIdempotencyLedger } from './card-feed.js';

export interface DaemonCheckpoint {
  version: number;
  lineage: string;
  generation: number;
  writer: string;
  sequence: number;
  sealed: boolean;
  pocket: ReturnType<AutonomousPocketEngine['snapshot']>;
  receipts: ReturnType<OutboxIdempotencyLedger['snapshot']>;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const counter = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= P.maxCounter;
const canonical = (v: unknown): string => JSON.stringify(v, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);

export function parseDaemonCheckpoint(text: unknown): DaemonCheckpoint | null {
  if (typeof text !== 'string' || Buffer.byteLength(text) > P.maxBytes) return null;
  try {
    const raw = JSON.parse(text);
    if (raw?.version !== P.version || !UUID.test(raw.lineage) || !UUID.test(raw.writer)
      || !counter(raw.generation) || !counter(raw.sequence) || typeof raw.sealed !== 'boolean' || !raw.pocket || raw.pocket.rev !== 1
      || !Array.isArray(raw.receipts) || raw.receipts.length > P.receiptLimit) return null;
    const pocket = new AutonomousPocketEngine({ persist: false });
    pocket.adopt(raw.pocket);
    if (canonical(raw.pocket) !== canonical(pocket.snapshot())) return null;
    if (raw.receipts.some((r: Record<string, unknown>) => !r || typeof r.key !== 'string'
      || !/^[a-f0-9]{64}$/.test(r.key) || !P.statuses.some(s => s === r.status))) return null;
    const ledger = new OutboxIdempotencyLedger(); ledger.restore(raw.receipts);
    return { version: P.version, lineage: raw.lineage.toLowerCase(), writer: raw.writer.toLowerCase(),
      generation: raw.generation, sequence: raw.sequence, sealed: raw.sealed, pocket: pocket.snapshot(), receipts: ledger.snapshot() };
  } catch { return null; }
}

export const checkpointId = (c: DaemonCheckpoint): string => `${c.writer}:${c.sequence}`;
export function checkpointIsNewer(incoming: DaemonCheckpoint, current: DaemonCheckpoint): boolean {
  if (incoming.lineage !== current.lineage) return true; // only a verified current local peer may change lineage
  if (incoming.generation !== current.generation) return incoming.generation > current.generation;
  return incoming.writer !== current.writer || incoming.sequence > current.sequence;
}
function read(path: string): DaemonCheckpoint | null {
  let text: string;
  try { text = readFileSync(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('daemon_checkpoint_unreadable'); }
  const value = parseDaemonCheckpoint(text);
  if (!value) throw new Error('daemon_checkpoint_invalid');
  return value;
}
function atomic(directory: string, name: string, value: DaemonCheckpoint): void {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > P.maxBytes) throw new Error('daemon_checkpoint_too_large');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, name), tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 }); renameSync(tmp, path);
}

/** Called only after local target/ownership validation, never for a relay frame. */
export function stagePeerCheckpoint(directory: string, payload: unknown): boolean {
  const incoming = parseDaemonCheckpoint(payload); if (!incoming) return false;
  const own = read(join(directory, 'daemon-checkpoint.json'));
  if (own?.lineage === incoming.lineage && !checkpointIsNewer(incoming, own)) return false;
  const prior = read(join(directory, 'daemon-checkpoint-peer.json'));
  if (prior && !checkpointIsNewer(incoming, prior)) return canonical(prior) === canonical(incoming);
  atomic(directory, 'daemon-checkpoint-peer.json', incoming); return true;
}

export class DaemonCheckpointStore {
  private current: DaemonCheckpoint;
  private content = '';
  constructor(private readonly directory: string, private readonly pocket: AutonomousPocketEngine,
    private readonly ledger: OutboxIdempotencyLedger) {
    const own = read(join(directory, 'daemon-checkpoint.json'));
    const peer = read(join(directory, 'daemon-checkpoint-peer.json'));
    const source = peer && (!own || checkpointIsNewer(peer, own)) ? peer : own;
    if (source && source.generation >= P.maxCounter) throw new Error('daemon_checkpoint_generation_exhausted');
    if (source && (source.lineage !== own?.lineage
      || (source.generation === own?.generation && source.writer !== own.writer))) {
      // Preserve the inactive local profile. Summing unrelated aggregate totals
      // cannot distinguish copied history from independent feedback.
      const previous = own ?? { version: P.version, lineage: randomUUID(), writer: randomUUID(), generation: 0,
        sequence: 0, sealed: false, pocket: pocket.snapshot(), receipts: ledger.snapshot() };
      const archive = `${previous.lineage}-${randomUUID()}`;
      atomic(directory, `daemon-checkpoint-profile-${archive}.json`, previous);
      const legacy = join(directory, 'pocket-autonomy.json');
      if (existsSync(legacy)) renameSync(legacy, join(directory, `pocket-autonomy-profile-${archive}.json`));
    }
    if (source) { pocket.adopt(source.pocket); ledger.restore(source.receipts); }
    // Without a current peer this is a new authority branch. Another runtime
    // may have advanced the old lineage while this process was absent. Keep
    // local aggregates/receipts, but do not make a valid fresh owner look stale.
    this.current = { version: P.version, lineage: own && source === own ? randomUUID() : source?.lineage ?? randomUUID(), generation: (source?.generation ?? 0) + 1,
      writer: randomUUID(), sequence: 0, sealed: false, pocket: pocket.snapshot(), receipts: ledger.snapshot() };
    this.capture();
    try { unlinkSync(join(directory, 'daemon-checkpoint-peer.json')); } catch { /* absent */ }
  }

  capture(sealed = false): string {
    const pocket = this.pocket.snapshot(), receipts = this.ledger.snapshot();
    const content = JSON.stringify({ pocket, receipts, sealed });
    if (content !== this.content) {
      if (this.current.sequence >= P.maxCounter) throw new Error('daemon_checkpoint_sequence_exhausted');
      this.current = { ...this.current, sequence: this.current.sequence + 1, sealed, pocket, receipts };
      atomic(this.directory, 'daemon-checkpoint.json', this.current);
      this.content = content;
    }
    return JSON.stringify(this.current);
  }

  get id(): string { return checkpointId(this.current); }
  get sequence(): number { return this.current.sequence; }
  acknowledgementSequence(id: string): number | null {
    const [writer, suffix, extra] = id.split(':');
    const value = Number(suffix);
    return writer === this.current.writer && extra === undefined && String(value) === suffix
      && counter(value) && value <= this.current.sequence ? value : null;
  }
}
