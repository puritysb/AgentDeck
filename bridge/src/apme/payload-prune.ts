/**
 * APME retention — the pruned-payload marker (#302).
 *
 * `steps.payload` and `sample_events.payload` (tool rows only) hold entire
 * hook bodies / tool input+output and are, measured on a live desk
 * (2026-09-09), 71% of a 2.33 GB `apme.sqlite` at ~7.7 KB/row. `agentdeck
 * apme prune` replaces an old row's `payload` with a small JSON marker
 * rather than deleting the row — `runs`/`tasks`/`turns`/`evals` (and every
 * OTHER sample_events kind: user_message/assistant_message/model/subagent/
 * state/info/relation) are never touched, and `steps`/`sample_events` rows
 * themselves are never deleted, because `getSteps`/`listSteps` and the
 * typed-trajectory readers (scorers, outcome, classifier, the graph, the
 * dashboard HTTP routes, the judge's trajectory lines) all key off the row
 * existing — only its payload content is reclaimed.
 *
 * A pruned row is still valid JSON, so a reader that merely does
 * `JSON.parse(payload)` and looks for its own keys already degrades to "no
 * content" for free (the marker has none of `command`/`file_path`/`input`/…).
 * `isPrunedPayload` exists for the handful of readers where that distinction
 * should be explicit rather than accidental — skip parsing entirely, or
 * (`runSampleScorers`'s trajectory-churn detector, the judge's trajectory
 * lines) avoid treating "two pruned tool calls with no input" as a detected
 * duplicate / a real empty call.
 */

import { statSync, statfsSync } from 'fs';
import { dirname } from 'path';

/** A string every marker this module writes starts with — `JSON.stringify`
 *  on a plain object with `pruned` as its first key is deterministic key
 *  order, so this is safe to use as a cheap SQL `LIKE` filter (excluding
 *  already-pruned rows from a preview/apply pass) without parsing JSON per
 *  row. `isPrunedPayload` below is the authoritative check — this constant
 *  is a performance shortcut for the store's SQL, not a second definition. */
export const PRUNED_PAYLOAD_LIKE = '%"pruned":true%';

export interface PrunedPayloadMarker {
  pruned: true;
  /** When the payload was replaced (epoch ms). */
  prunedAt: number;
  /** Length (chars) of the payload this marker replaced — lets a reader
   *  that cares (e.g. a size audit) see what was there without keeping it. */
  bytes: number;
}

/** Build the marker payload that replaces a pruned row's content. */
export function buildPrunedPayload(originalLength: number, prunedAt: number = Date.now()): string {
  const marker: PrunedPayloadMarker = { pruned: true, prunedAt, bytes: originalLength };
  return JSON.stringify(marker);
}

/** True when `payload` is a marker written by `buildPrunedPayload` (or
 *  anything shaped like one) rather than real hook/tool content. Readers
 *  that extract structured fields from a `steps`/`sample_events` payload
 *  should check this FIRST and treat a pruned row as "no content" —
 *  never crash on it, and never let its absence of familiar keys silently
 *  read as a real signal (e.g. an empty Bash command, a missing file path). */
export function isPrunedPayload(payload: string | null | undefined): boolean {
  if (!payload) return false;
  // Marker payloads are short; anything long enough to plausibly be real
  // hook/tool content is not worth a JSON.parse just to say no.
  if (payload.length > 256) return false;
  let parsed: unknown;
  try { parsed = JSON.parse(payload); } catch { return false; }
  return !!parsed && typeof parsed === 'object' && (parsed as Record<string, unknown>).pruned === true;
}

// ─── VACUUM free-space gate ────────────────────────────────────────────────

export interface VacuumSpaceCheck {
  ok: boolean;
  /** Bytes free on the volume holding the DB, available to this user. */
  freeBytes: number;
  /** 1.1x the DB file's current size — VACUUM rewrites the whole file into a
   *  fresh copy before replacing the original, so it transiently needs
   *  roughly the file's own size again; 1.1x leaves headroom rather than
   *  cutting it exactly at the line. */
  requiredBytes: number;
  fileBytes: number;
}

/** Injectable so a test can assert both branches without needing a full or
 *  a nearly-full real filesystem. Defaults to real `fs` calls. */
export interface VacuumSpaceProbe {
  statSize(path: string): number;
  /** Free bytes available on the volume containing `path`. */
  statfsFreeBytes(path: string): number;
}

function realVacuumSpaceProbe(): VacuumSpaceProbe {
  return {
    statSize: (p: string) => statSync(p).size,
    statfsFreeBytes: (p: string) => {
      const s = statfsSync(dirname(p));
      return s.bavail * s.bsize;
    },
  };
}

/** Whether VACUUM is safe to run against `dbPath` right now: free disk space
 *  on its volume must be at least 1.1x the file's current size. Read-only —
 *  callers gate the VACUUM call on `.ok` and explain a `false` result rather
 *  than running it and hoping. */
export function checkVacuumSpace(dbPath: string, probe: VacuumSpaceProbe = realVacuumSpaceProbe()): VacuumSpaceCheck {
  const fileBytes = probe.statSize(dbPath);
  const requiredBytes = Math.ceil(fileBytes * 1.1);
  const freeBytes = probe.statfsFreeBytes(dbPath);
  return { ok: freeBytes >= requiredBytes, freeBytes, requiredBytes, fileBytes };
}

// ─── Prune result shape ─────────────────────────────────────────────────────

export interface PruneEstimate {
  rows: number;
  bytesBefore: number;
  /** null on a dry-run preview — pruning was not performed, so there is no
   *  observed after-value (only an estimate: `bytesBefore` minus a marker's
   *  negligible size). Non-null after `applyPrune` actually ran. */
  bytesAfter: number | null;
}

export function emptyPruneEstimate(): PruneEstimate {
  return { rows: 0, bytesBefore: 0, bytesAfter: 0 };
}
