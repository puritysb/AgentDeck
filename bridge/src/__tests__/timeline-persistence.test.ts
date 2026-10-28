/**
 * Daemon-owned timeline persistence.
 *
 * The daemon is the timeline's source of truth — every surface's entries flow
 * through it — so it owns the on-disk file. This replaced an inversion where
 * the Stream Deck plugin was the only writer of `~/.agentdeck/timeline.json`
 * and the daemon merely read it, which meant a user without a Stream Deck got
 * no persistence at all.
 *
 * Two properties are load-bearing and invisible from normal daemon behaviour:
 *   1. Session bridges must NOT write. Several run concurrently and would
 *      interleave partial histories over the daemon's file.
 *   2. The file format is shared with the Swift daemon
 *      (`DaemonTimelineStore.flush`/`loadFromDisk`), which reads and writes the
 *      same plain JSON array. Either daemon must be able to resume from the
 *      other's file.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { BridgeTimelineStore } from '../timeline-store.js';
import type { TimelineEntry } from '../types.js';

let dir: string;
let file: string;

function entry(over: Partial<TimelineEntry> = {}): TimelineEntry {
  return {
    ts: 1_700_000_000_000,
    type: 'chat_start',
    raw: 'hello',
    ...over,
  } as TimelineEntry;
}

beforeEach(() => {
  dir = join(tmpdir(), `agentdeck-timeline-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  file = join(dir, 'timeline.json');
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

function read(): unknown[] {
  return JSON.parse(readFileSync(file, 'utf-8'));
}

describe('persistence is opt-in', () => {
  it('writes nothing until enablePersistence is called', () => {
    const store = new BridgeTimelineStore();
    store.addEntry(entry());
    vi.advanceTimersByTime(5000);
    store.flushPersist();

    // A session bridge builds this same class. If it ever wrote, concurrent
    // bridges would clobber the daemon's history.
    expect(existsSync(file)).toBe(false);
  });

  it('writes once enabled', () => {
    const store = new BridgeTimelineStore();
    store.enablePersistence(file);
    store.addEntry(entry());
    vi.advanceTimersByTime(1000);

    expect(existsSync(file)).toBe(true);
    expect(read()).toHaveLength(1);
  });
});

describe('write behaviour', () => {
  it('coalesces a burst of entries into a single write', () => {
    const store = new BridgeTimelineStore();
    store.enablePersistence(file);

    // One turn: chat_start + tools + response + end.
    store.addEntry(entry({ ts: 1, type: 'chat_start', raw: 'a' }));
    store.addEntry(entry({ ts: 2, type: 'tool_exec', raw: 'b' }));
    store.addEntry(entry({ ts: 3, type: 'chat_response', raw: 'c' }));
    expect(existsSync(file)).toBe(false);   // still inside the debounce window

    vi.advanceTimersByTime(1000);
    expect(read()).toHaveLength(3);
  });

  it('leaves no temp file behind', () => {
    const store = new BridgeTimelineStore();
    store.enablePersistence(file);
    store.addEntry(entry());
    vi.advanceTimersByTime(1000);

    const stray = readdirSync(dir).filter(f => f.endsWith('.tmp'));
    expect(stray, `temp files left: ${stray.join(', ')}`).toEqual([]);
  });

  it('flushes pending entries on shutdown instead of losing them', () => {
    const store = new BridgeTimelineStore();
    store.enablePersistence(file);
    store.addEntry(entry({ raw: 'last words' }));
    expect(existsSync(file)).toBe(false);   // debounce still pending

    store.stopPersistence();

    expect(existsSync(file)).toBe(true);
    expect(JSON.stringify(read())).toContain('last words');
  });

  it('stopPersistence is safe when nothing is pending', () => {
    const store = new BridgeTimelineStore();
    store.enablePersistence(file);
    expect(() => { store.stopPersistence(); store.stopPersistence(); }).not.toThrow();
  });

  it('survives an unwritable path rather than taking the daemon down', () => {
    const store = new BridgeTimelineStore();
    store.enablePersistence(join(dir, 'nope', '\0bad', 'timeline.json'));
    expect(() => {
      store.addEntry(entry());
      vi.advanceTimersByTime(1000);
    }).not.toThrow();
  });
});

// #625: an update to a row that already reached disk must reach disk too. The
// APME task_end re-emit lands 5–30 s after the first one, long after the 500 ms
// debounce fired, and a clean shutdown with no newer row used to drop it.
describe('late updates to an already-written row', () => {
  function writtenStore(first: TimelineEntry): BridgeTimelineStore {
    const store = new BridgeTimelineStore();
    store.enablePersistence(file);
    store.addEntry(first);
    vi.advanceTimersByTime(1000);
    return store;
  }

  it('persists a ts-matched upsert (late LLM summary on chat_end)', () => {
    const store = writtenStore(entry({ type: 'chat_end', raw: 'before', sessionId: 's1' }));
    store.upsertEntry(entry({ type: 'chat_end', raw: 'after', sessionId: 's1', detail: 'late summary', summaryKind: 'llm' }));
    store.stopPersistence();

    const rows = read() as TimelineEntry[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ raw: 'after', detail: 'late summary', summaryKind: 'llm' });
  });

  it('persists a task_end merged by taskId (late evaluation result)', () => {
    const store = writtenStore(entry({ type: 'task_end', raw: 'before', taskId: 't1' }));
    store.upsertEntry(entry({ ts: 1_700_000_020_000, type: 'task_end', raw: 'after', taskId: 't1', taskScore: 88, taskSummary: 'done' }));
    store.stopPersistence();

    const rows = read() as TimelineEntry[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ raw: 'after', taskScore: 88, taskSummary: 'done' });
  });

  it('persists an approval status change', () => {
    const store = writtenStore(entry({ type: 'permission_request', raw: 'allow?', approvalId: 'a1' }));
    store.updateEntryStatus('a1', 'approved');
    store.stopPersistence();

    expect((read() as TimelineEntry[])[0]).toMatchObject({ approvalId: 'a1', status: 'approved' });
  });

  it('reaches disk on the debounce timer alone, without a shutdown flush', () => {
    const store = writtenStore(entry({ type: 'chat_end', raw: 'before', sessionId: 's1' }));
    store.upsertEntry(entry({ type: 'chat_end', raw: 'after', sessionId: 's1' }));
    vi.advanceTimersByTime(1000);

    expect((read() as TimelineEntry[])[0]).toMatchObject({ raw: 'after' });
    store.stopPersistence();
  });
});

describe('round-trip', () => {
  it('a written file reloads into an equivalent buffer', () => {
    const a = new BridgeTimelineStore();
    a.enablePersistence(file);
    a.addEntry(entry({ ts: 10, type: 'chat_start', raw: 'first' }));
    a.addEntry(entry({ ts: 20, type: 'chat_response', raw: 'second' }));
    a.stopPersistence();

    const b = new BridgeTimelineStore();
    const loaded = b.loadPersistedFile(file);

    expect(loaded).toBe(2);
    expect(b.getHistory().map(e => e.raw)).toEqual(['first', 'second']);
  });

  it('restored history is included in the next write, not truncated away', () => {
    const a = new BridgeTimelineStore();
    a.enablePersistence(file);
    a.addEntry(entry({ ts: 10, type: 'chat_start', raw: 'old' }));
    a.stopPersistence();

    // Mirrors daemon startup order: load first, THEN take ownership.
    const b = new BridgeTimelineStore();
    b.loadPersistedFile(file);
    b.enablePersistence(file);
    b.addEntry(entry({ ts: 20, type: 'chat_start', raw: 'new' }));
    b.stopPersistence();

    const raws = (read() as TimelineEntry[]).map(e => e.raw);
    expect(raws).toContain('old');
    expect(raws).toContain('new');
  });
});

describe('cross-implementation format contract (Swift DaemonTimelineStore)', () => {
  it('writes a plain JSON array, not a wrapper object', () => {
    const store = new BridgeTimelineStore();
    store.enablePersistence(file);
    store.addEntry(entry());
    store.stopPersistence();

    // Swift decodes `[DaemonTimelineEntry].self` directly — an object wrapper
    // would decode to nil there and silently drop all history.
    expect(Array.isArray(read())).toBe(true);
  });

  it('every row carries the ts/type/raw triple both implementations require', () => {
    const store = new BridgeTimelineStore();
    store.enablePersistence(file);
    store.addEntry(entry({ ts: 1, type: 'chat_start', raw: 'a' }));
    store.addEntry(entry({ ts: 2, type: 'task_start', raw: 'b', taskId: 'T1' } as Partial<TimelineEntry>));
    store.stopPersistence();

    for (const row of read() as Record<string, unknown>[]) {
      expect(typeof row.ts, JSON.stringify(row)).toBe('number');
      expect(typeof row.type, JSON.stringify(row)).toBe('string');
      expect(typeof row.raw, JSON.stringify(row)).toBe('string');
    }
  });

  it('reads a file in the shape the Swift daemon writes', () => {
    // Written by hand in Swift's shape: plain array, camelCase fields.
    writeFileSync(file, JSON.stringify([
      { ts: 1, type: 'chat_start', raw: 'from swift' },
      { ts: 2, type: 'chat_end', raw: 'done', endedAt: 3 },
    ]), 'utf-8');

    const store = new BridgeTimelineStore();
    expect(store.loadPersistedFile(file)).toBe(2);
    expect(store.getHistory().map(e => e.raw)).toEqual(['from swift', 'done']);
  });

  it('treats a corrupt file as empty history rather than throwing', () => {
    writeFileSync(file, '{ this is not json', 'utf-8');
    const store = new BridgeTimelineStore();
    expect(store.loadPersistedFile(file)).toBe(0);
  });
});
