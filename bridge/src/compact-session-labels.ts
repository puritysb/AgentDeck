import { truncateUtf8Bytes } from '@agentdeck/shared';

// Short labels are presentation only. Compute before cap/paging, never fold or
// route by them. Reserve room for a roster ordinal inside firmware's 39 bytes.
export const COMPACT_PROJECT_BYTES = 32;
export const TTGO_COMPACT_PROJECT_BYTES = 12;
export function compactSessionLabels(rows: { id: string; name: string }[], board?: string): Map<string, string> {
  const cap = board === 'ttgo_t_display' ? TTGO_COMPACT_PROJECT_BYTES : COMPACT_PROJECT_BYTES;
  const groups = new Map<string, string[]>();
  for (const row of rows) {
    const base = truncateUtf8Bytes(row.name || 'Session', cap);
    const ids = groups.get(base) ?? [];
    if (!ids.includes(row.id)) ids.push(row.id);
    groups.set(base, ids);
  }
  const labels = new Map<string, string>();
  for (const [base, ids] of groups) {
    ids.sort(); // ID order, never state/attention order: activity cannot renumber.
    ids.forEach((id, index) => labels.set(id, ids.length > 1 ? `${base} #${index + 1}` : base));
  }
  return labels;
}
