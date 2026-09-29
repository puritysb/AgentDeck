/**
 * Daemon-persisted sort-order pins for passively observed sessions (#273,
 * "Session ordering" replacement gate).
 *
 * `--weight` today is a launch-time flag of the managed PTY path: it is set
 * once by `agentdeck <agent> --weight <n>` and dies with the session bridge.
 * A normally launched observed session (`claude` / `codex` / `opencode` run
 * directly, daemon installed) has no way to carry a weight at all — the rows
 * are minted by the process scan and the hooks, neither of which has a
 * user-attachable argument. This store is the daemon-first replacement: the
 * daemon owns a small JSON file of weight pins keyed on the observed
 * session's stable identity, applies them when it builds `sessions_list`, and
 * keeps them across daemon restarts.
 *
 * ## Identity and lifecycle rules (the #273 deliverable)
 *
 * - **Key = bare session id** (`rawSessionId` of the `sessions_list` id), so
 *   `observed:claude:<uuid>` and the bare `<uuid>` a hook or timeline row
 *   carries address the same pin. Never a per-board literal or a truncated
 *   device echo — the two id forms are normalized through the shared SSOT.
 * - **A pin survives daemon restarts** (persisted file, atomic tmp+rename)
 *   **and session re-listing** (the observer rescan mints fresh rows for the
 *   same id; the overlay reapplies).
 * - **A pin survives session end within the TTL**: `claude --resume <uuid>`
 *   produces the same session id, so a pin set days earlier still orders the
 *   resumed session. `lastSeenAt` advances whenever the daemon builds a
 *   roster containing the id; a pin whose session has been absent from every
 *   roster for SESSION_ORDER_TTL_MS is garbage-collected (default 30 days).
 * - **Bound**: at most MAX_SESSION_ORDER_PINS entries; past the cap the
 *   least-recently-seen pins are evicted first. The file is user data, not a
 *   leak — it cannot grow without bound.
 * - **Precedence**: the overlay applies ONLY to rows with
 *   `controlMode === 'observed'` AND no weight of their own. Managed and
 *   remote rows carry the launch-time `--weight` contract and keep it; the
 *   store never overrides an explicit value. Weight `0` is the default band,
 *   so setting 0 is a clear, not a pin.
 *
 * Swift parity: the in-process Swift daemon does not read this file. Pins
 * apply while the Node daemon owns the hub; `agentdeck order` against a Swift
 * daemon reports the gap instead of pretending (docs/daemon.md).
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';
import {
  rawSessionId,
  sessionWeight,
  SESSION_WEIGHT_MIN,
  SESSION_WEIGHT_MAX,
  SESSION_ORDER_TTL_MS,
  MAX_SESSION_ORDER_PINS,
} from '@agentdeck/shared';
import { getDataDir } from './session-registry.js';
import { debug } from './logger.js';

/**
 * A pin whose session has been absent from every roster for this long is GC'd.
 * Cross-daemon file contract (the Swift daemon reads/writes the same file) —
 * SSOT in shared/src/session-utils.ts, mirrored via
 * `pnpm generate-session-weight-rules`.
 */
export { SESSION_ORDER_TTL_MS, MAX_SESSION_ORDER_PINS };

/** Upper bound on persisted pins; past it the least-recently-seen go first. */

/** `lastSeenAt` is only worth a persist when it moved by at least this much. */
const SEEN_PERSIST_THRESHOLD_MS = 60_000;

/** Coalescing window for `lastSeenAt` writes (the rosters run every few s). */
const PERSIST_DEBOUNCE_MS = 5_000;

export interface SessionOrderPin {
  /** Clamped integer in SESSION_WEIGHT_MIN..MAX; never 0 (0 = clear). */
  weight: number;
  /** Epoch ms of the last user write (`set`/`clear`). */
  updatedAt: number;
  /** Epoch ms the id last appeared in a roster this daemon built. */
  lastSeenAt: number;
}

/** Serialized file shape. Forward-compatible via `version`. */
interface SessionOrderFile {
  version: 1;
  pins: Record<string, SessionOrderPin>;
}

export function sessionOrderFilePath(): string {
  return join(getDataDir(), 'session-order.json');
}

export type SessionOrderTarget =
  | { status: 'resolved'; id: string }
  | { status: 'ambiguous'; candidates: string[] };

/**
 * Resolve a user-supplied session reference against the current roster.
 *
 * Accepts the exact `sessions_list` id, a device-truncated echo (31 chars —
 * `resolveSessionIdPrefix` restores it), or the bare uuid timeline rows
 * carry — and, critically, in EITHER id form against a roster in the other:
 * the Node daemon addresses observed sessions as `observed:claude:<uuid>`
 * while the Swift daemon's rows carry the bare `<uuid>`, so a reference
 * copied from one daemon's world must resolve against the other's roster
 * (found live 2026-09-19: an `observed:claude:` prefix keyed a pin on the
 * truncated uuid against Swift's bare roster and never applied). Both the
 * input and every known id are therefore tried in raw and prefix form. An
 * id that matches nothing on the roster is still accepted as-is (pinning a
 * not-currently-live session is legal — the pin just waits for the id to
 * reappear); only genuine prefix ambiguity between live sessions is refused,
 * naming the candidates.
 */
export function resolveSessionOrderTarget(raw: string, knownIds: readonly string[]): SessionOrderTarget {
  const input = raw.trim();
  const rawInput = rawSessionId(input);
  const ids = knownIds.filter((id) => typeof id === 'string' && id);
  const forms = (id: string): string[] => {
    const stripped = rawSessionId(id);
    return stripped !== id ? [id, stripped] : [id];
  };
  // Exact match in either form on either side.
  for (const id of ids) {
    for (const form of forms(id)) {
      if (form === input || (rawInput && form === rawInput)) return { status: 'resolved', id };
    }
  }
  // Prefix match: the input (or its bare form) as a prefix of a known id
  // (or its bare form) — the device-truncated echo in both rosters' shapes.
  let match: string | null = null;
  const candidates = new Set<string>();
  const prefixes = rawInput && rawInput !== input ? [input, rawInput] : [input];
  for (const id of ids) {
    for (const form of forms(id)) {
      for (const p of prefixes) {
        if (p && form.startsWith(p)) {
          candidates.add(id);
          match = id;
        }
      }
    }
  }
  if (candidates.size === 1) return { status: 'resolved', id: match as string };
  if (candidates.size > 1) return { status: 'ambiguous', candidates: [...candidates] };
  // Not live: keep the caller's spelling, normalized to the bare key form.
  return { status: 'resolved', id: rawSessionId(input) };
}

/**
 * Validate a pin weight from an untrusted body. Returns the integer weight,
 * or undefined when the field is absent/invalid — the route answers 400 with
 * the same message shape the CLI `--weight` parser uses.
 */
export function parseSessionOrderWeight(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n)
    || n < SESSION_WEIGHT_MIN || n > SESSION_WEIGHT_MAX) {
    return undefined;
  }
  return n;
}

export interface SessionOrderStoreDeps {
  file?: string;
  now?: () => number;
}

export class SessionOrderStore {
  private pins = new Map<string, SessionOrderPin>();
  private readonly file: string;
  private readonly now: () => number;
  private persistTimer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(deps: SessionOrderStoreDeps = {}) {
    this.file = deps.file ?? sessionOrderFilePath();
    this.now = deps.now ?? Date.now;
  }

  /** Load (tolerantly) and GC. Corrupt/missing file ⇒ empty store, never a throw. */
  load(): this {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf-8')) as Partial<SessionOrderFile>;
      if (parsed && typeof parsed === 'object' && parsed.pins && typeof parsed.pins === 'object') {
        for (const [id, pin] of Object.entries(parsed.pins)) {
          if (!id || !pin || typeof pin !== 'object') continue;
          const weight = sessionWeight((pin as SessionOrderPin).weight);
          // 0 pins are meaningless (default band) — drop rather than carry.
          if (weight === 0) continue;
          const updatedAt = Number((pin as SessionOrderPin).updatedAt);
          const lastSeenAt = Number((pin as SessionOrderPin).lastSeenAt);
          this.pins.set(rawSessionId(id), {
            weight,
            updatedAt: Number.isFinite(updatedAt) ? updatedAt : this.now(),
            lastSeenAt: Number.isFinite(lastSeenAt) ? lastSeenAt : this.now(),
          });
        }
      }
    } catch {
      // Missing or malformed — start empty. Never take the daemon down.
    }
    this.gc();
    return this;
  }

  /** The stored weight for a session id (either id form), or undefined. */
  weightFor(id: string): number | undefined {
    return this.pins.get(rawSessionId(id))?.weight;
  }

  /**
   * Overlay a stored pin onto one roster row. Observed rows without their own
   * weight get the pin; managed/remote rows and rows that already carry a
   * weight pass through untouched (precedence rule in the module doc).
   */
  applyTo<T extends { id: string; controlMode?: string; weight?: number }>(row: T): T {
    if (row.controlMode !== 'observed' || row.weight != null) return row;
    const weight = this.pins.get(rawSessionId(row.id))?.weight;
    return weight === undefined ? row : { ...row, weight };
  }

  /**
   * Set (or, for 0, clear) a pin. Returns the applied weight, or undefined
   * when the pin was cleared. Persists synchronously — a CLI-visible action
   * must survive an immediate daemon crash.
   */
  set(id: string, weight: number): number | undefined {
    const key = rawSessionId(id);
    const clamped = sessionWeight(weight);
    if (clamped === 0) {
      this.clear(key);
      return undefined;
    }
    const existing = this.pins.get(key);
    const pin: SessionOrderPin = {
      weight: clamped,
      updatedAt: this.now(),
      lastSeenAt: Math.max(existing?.lastSeenAt ?? 0, this.now()),
    };
    this.pins.set(key, pin);
    this.gc();
    this.persist();
    debug('SessionOrder', `Pinned ${key} to weight ${clamped}`);
    return clamped;
  }

  /** Remove a pin. Returns true when one existed. Persists synchronously. */
  clear(id: string): boolean {
    const key = rawSessionId(id);
    const had = this.pins.delete(key);
    if (had) {
      this.persist();
      debug('SessionOrder', `Cleared pin for ${key}`);
    }
    return had;
  }

  /** All pins, keyed by bare id, for `GET /sessions/order`. */
  list(): Array<{ id: string } & SessionOrderPin> {
    return [...this.pins.entries()]
      .map(([id, pin]) => ({ id, ...pin }))
      .sort((a, b) => a.weight - b.weight || a.id.localeCompare(b.id));
  }

  /**
   * Advance `lastSeenAt` for every id the daemon just rostered. Throttled per
   * pin (a roster runs every few seconds; a persist per roster would churn
   * the file for a timestamp nobody reads at that resolution) and coalesced
   * through a debounced write.
   */
  noteSeen(ids: Iterable<string>): void {
    if (this.pins.size === 0) return;
    const now = this.now();
    let changed = false;
    for (const id of ids) {
      const pin = this.pins.get(rawSessionId(id));
      if (!pin) continue;
      if (now - pin.lastSeenAt < SEEN_PERSIST_THRESHOLD_MS) continue;
      pin.lastSeenAt = now;
      changed = true;
    }
    if (changed) this.schedulePersist();
  }

  /**
   * Drop pins whose sessions have been unseen past the TTL, and enforce the
   * size cap (oldest `lastSeenAt` first). Returns the number removed.
   */
  gc(now = this.now()): number {
    const before = this.pins.size;
    for (const [id, pin] of this.pins) {
      if (now - pin.lastSeenAt > SESSION_ORDER_TTL_MS) this.pins.delete(id);
    }
    if (this.pins.size > MAX_SESSION_ORDER_PINS) {
      const bySeen = [...this.pins.entries()]
        .sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt);
      for (let i = 0; i < this.pins.size - MAX_SESSION_ORDER_PINS; i++) {
        this.pins.delete(bySeen[i][0]);
      }
    }
    return before - this.pins.size;
  }

  private schedulePersist(): void {
    this.dirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.flush();
    }, PERSIST_DEBOUNCE_MS);
    this.persistTimer.unref?.();
  }

  /** Atomic tmp+rename write. Best-effort: disk failure never throws. */
  private persist(): void {
    this.dirty = false;
    const doc: SessionOrderFile = {
      version: 1,
      pins: Object.fromEntries(this.pins),
    };
    const tmp = join(dirname(this.file), `.session-order.${randomUUID()}.tmp`);
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf-8');
      renameSync(tmp, this.file);
    } catch {
      try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
    }
  }

  /** Flush a pending debounced write now (daemon shutdown path). */
  flush(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.dirty) this.persist();
  }

  get size(): number {
    return this.pins.size;
  }
}
