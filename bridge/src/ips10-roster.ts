/** IPS10 bounded roster policy SSOT. Swift consumer is generated from this file. */
export const IPS10_ROSTER_PERIOD_MS = 60_000;
export const IPS10_ATTENTION_SLOTS = 3;

/** Input indices are ordered attention first, then other sessions. Keep capacity
 * bounded while visiting every remaining index, even when attention exceeds cap. */
export function ips10RosterIndices(total: number, attention: number, cap: number, nowMs: number): number[] {
  if (cap <= 0 || total <= 0) return [];
  if (total <= cap) return Array.from({ length: total }, (_, i) => i);
  const pinned = Math.min(attention, IPS10_ATTENTION_SLOTS, cap - 1);
  const slots = cap - pinned;
  const remaining = total - pinned;
  const offset = (Math.floor(Math.max(0, nowMs) / IPS10_ROSTER_PERIOD_MS) * slots) % remaining;
  return [...Array.from({ length: pinned }, (_, i) => i),
    ...Array.from({ length: slots }, (_, i) => pinned + (offset + i) % remaining)];
}
