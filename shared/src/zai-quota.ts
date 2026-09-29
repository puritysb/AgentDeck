/**
 * Z.ai GLM Coding Plan quota rules — the SSOT for reading the provider's
 * monitor response (`GET /api/monitor/usage/quota/limit`) into wire windows.
 *
 * WHY THIS IS AN SSOT: both daemons PRODUCE the wire snapshot (Node polls with
 * its own provider-key config, Swift with its Keychain copy), so the mapping
 * from the provider's `limits[]` items to the primary/secondary wire slots is
 * cross-platform logic. The Swift mirror is generated
 * (`pnpm generate-zai-quota-rules`) and both suites replay
 * `shared/zai-quota-vectors.json` — a rule restated in another language's own
 * words is a rule that can drift. Kotlin is a pure consumer of the wire and
 * needs no mirror.
 *
 * The endpoint is undocumented (docs.z.ai points at the web dashboard) — the
 * same status as Codex's account endpoint, with the same discipline: read-only
 * GET, treat absent fields as unknown, never fabricate a percentage or a reset
 * instant. Observed 2026-09-19 against a Max-plan account; community parsers
 * (TokenStep, opencode-bar) corroborate the shapes.
 *
 * Axis model — the same four the Codex windows carry:
 *   • window ended      → `resetsAt` in the past (shared `isCodexWindowStale`)
 *   • reading is old    → `capturedAt`, derived at the consumer
 *   • whose number      → `planType` (the `data.level` stamped per snapshot)
 *   • which limit       → `limitId` schema family: "standard" (TOKENS_LIMIT
 *     5h + TIME_LIMIT monthly-MCP items) vs "credit" (credit-only schema,
 *     lite tier: unit=3/number=5 session + unit=6/number=1 weekly)
 */

import type { ZaiRateLimits } from './protocol.js';

/** 5-hour rolling credits window (`TOKENS_LIMIT`, or `CREDIT_LIMIT unit=3`). */
export const ZAI_SESSION_WINDOW_MINUTES = 300;
/** 7-day credits window, credit schema only (`CREDIT_LIMIT unit=6`). */
export const ZAI_WEEKLY_WINDOW_MINUTES = 10080;
/** Monthly MCP/tools window, standard schema (`TIME_LIMIT` ≈ 30d). */
export const ZAI_MCP_WINDOW_MINUTES = 43200;

/** Display names, kept beside the ids so a surface never spells one itself. */
export const ZAI_PLAN_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  lite: 'Lite',
  pro: 'Pro',
  max: 'Max',
};

/** Display name for a raw plan `level`. An unrecognised tier is capitalised,
 *  never dropped — same polarity as `formatChatGptPlanName`. */
export function formatZaiPlanName(planType?: string | null): string | undefined {
  const raw = (planType ?? '').trim();
  if (!raw) return undefined;
  const known = ZAI_PLAN_DISPLAY_NAMES[raw.toLowerCase()];
  return known ?? raw.charAt(0).toUpperCase() + raw.slice(1);
}

/**
 * A pay-as-you-go key is not a coding plan: the monitor endpoint answers, but
 * there are no subscription windows to show, and rendering "no windows" as a
 * gauge would dress absence up as exhaustion. Detected by key shape (`sk-pay…`
 * / `…payg…`), the marker community parsers use.
 */
export function zaiKeyLooksPayAsYouGo(apiKey?: string | null): boolean {
  const raw = (apiKey ?? '').trim().toLowerCase();
  if (!raw) return false;
  return raw.startsWith('sk-pay') || raw.includes('payg');
}

/** Which kind of quota window a monitor `limits[]` item describes. */
export type ZaiLimitKind = 'session' | 'weekly' | 'mcp' | 'unknown';

/** One classified monitor item — kind + the numbers a window can carry. */
export interface ZaiWindowReading {
  kind: ZaiLimitKind;
  /** Percent already CONSUMED, 0–100. Never fabricated: `percentage` when the
   *  item carries it, else `currentValue / (total ?? usage)` when both are
   *  finite — else the item is skipped (null), not guessed. */
  usedPercent: number;
  /** Reset instant, epoch-ms integer, when the item carries one. Absent is
   *  "unknown", never "no reset": the 5h window has been observed both with
   *  and without `nextResetTime` across schema revisions. */
  resetsAtMs?: number;
}

/**
 * Classify one monitor `limits[]` item, or null when it carries no usable
 * window (wrong shape, no derivable percent, or an unrecognized type).
 *
 * `type` is authoritative; `unit`/`number` corroborate on the credit schema,
 * where only CREDIT_LIMIT items exist and the two rolling windows are told
 * apart by `unit` (3 = hours×5 → session, 6 = weeks×1 → weekly).
 */
export function classifyZaiLimitItem(item: unknown): ZaiWindowReading | null {
  if (item == null || typeof item !== 'object') return null;
  const o = item as Record<string, unknown>;
  const type = typeof o.type === 'string' ? o.type.trim().toUpperCase() : '';

  let kind: ZaiLimitKind;
  const unit = typeof o.unit === 'number' && Number.isFinite(o.unit) ? o.unit : undefined;
  if (type === 'TOKENS_LIMIT') {
    kind = 'session';
  } else if (type === 'TIME_LIMIT') {
    kind = 'mcp';
  } else if (type === 'CREDIT_LIMIT') {
    if (unit === 3) kind = 'session';
    else if (unit === 6) kind = 'weekly';
    else kind = 'unknown';
  } else {
    kind = 'unknown';
  }
  if (kind === 'unknown') return null;

  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  let usedPercent = num(o.percentage);
  if (usedPercent == null) {
    const currentValue = num(o.currentValue);
    // CREDIT_LIMIT items report capacity as `usage` when `total` is absent —
    // `currentValue` stays the consumed amount either way.
    const capacity = num(o.total) ?? num(o.usage);
    if (currentValue == null || capacity == null || capacity <= 0) return null;
    usedPercent = (currentValue / capacity) * 100;
  }
  if (usedPercent < 0) return null;

  const resetsAtMs = num(o.nextResetTime);
  return {
    kind,
    usedPercent: Math.min(100, usedPercent),
    ...(resetsAtMs != null && resetsAtMs > 0 ? { resetsAtMs } : {}),
  };
}

/** Wire windows (minus `capturedAt`, which the fetcher stamps) + plan axes. */
export type ZaiQuotaWindows = Omit<ZaiRateLimits, 'capturedAt'>;

/**
 * Map a monitor response body onto wire windows.
 *
 * Slot assignment is BY LENGTH, matching `normalizeCodexRateLimits`: the 5h
 * session window → `primary`; the long window → `secondary`, preferring the
 * weekly credits window (plan quota) over the monthly MCP window (tools quota)
 * when a schema reports both. Slot-based consumers (ESP32 firmware labels
 * primary=5H, secondary=7D) keep their grammar; `limitId` carries which
 * quantity the secondary actually is.
 *
 * `level` rides in as `planType` unchanged when present — absence stays
 * absence ("no information"), and an unrecognized tier still displays via
 * `formatZaiPlanName`'s capitalisation path.
 */
export function zaiQuotaFromLimits(limits: unknown, level: unknown): ZaiQuotaWindows {
  const out: ZaiQuotaWindows = {};
  if (typeof level === 'string' && level.trim()) out.planType = level.trim().toLowerCase();

  if (!Array.isArray(limits) || limits.length === 0) return out;

  let session: ZaiWindowReading | null = null;
  let weekly: ZaiWindowReading | null = null;
  let mcp: ZaiWindowReading | null = null;
  let sawCreditItem = false;
  for (const item of limits) {
    if (item != null && typeof item === 'object' &&
        (item as Record<string, unknown>).type === 'CREDIT_LIMIT') {
      sawCreditItem = true;
    }
    const reading = classifyZaiLimitItem(item);
    if (!reading) continue;
    if (reading.kind === 'session') session ??= reading;
    else if (reading.kind === 'weekly') weekly ??= reading;
    else if (reading.kind === 'mcp') mcp ??= reading;
  }
  // The family describes the windows this response was read from; an empty
  // item list read nothing, so it claims no family either.
  out.limitId = sawCreditItem ? 'credit' : 'standard';

  const windowMinutesFor = (kind: ZaiLimitKind): number =>
    kind === 'weekly' ? ZAI_WEEKLY_WINDOW_MINUTES
      : kind === 'mcp' ? ZAI_MCP_WINDOW_MINUTES
        : ZAI_SESSION_WINDOW_MINUTES;
  const toWindow = (r: ZaiWindowReading): import('./protocol.js').ZaiWindow => ({
    usedPercent: Math.round(r.usedPercent),
    windowMinutes: windowMinutesFor(r.kind),
    // The quantity a surface must not conflate: MCP meters tool CALLS, the
    // others meter token credits.
    quantity: r.kind === 'mcp' ? 'mcp' : 'tokens',
    ...(r.resetsAtMs != null ? { resetsAt: new Date(r.resetsAtMs).toISOString() } : {}),
  });

  if (session) out.primary = toWindow(session);
  const long = weekly ?? mcp;
  if (long) out.secondary = toWindow(long);
  return out;
}
