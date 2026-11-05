/**
 * Deck labels for sessions that would otherwise look identical (#544).
 *
 * A deck key shows a session's project name, agent creature and state. Two
 * sessions of the same agent in the same project (two terminal tabs, parallel
 * tasks in one repository) therefore render as the same key, and a press — or
 * a voice prompt from that session's detail view — can land on the wrong one.
 *
 * Only colliding rows get a tag, so a lone session keeps its usual look. The
 * tag is the shortest prefix (≥ 4 characters) of the bare session id that is
 * unique inside its collision group:
 * - it does not depend on order or activity, unlike a `#N` ordinal, which
 *   renumbers when an older sibling ends. It can LENGTHEN when a sibling with
 *   the same leading characters appears, but it stays a prefix of the same id;
 * - both daemons emit it (the Swift daemon keys an observed Claude session on
 *   the bare uuid, Node on `observed:claude:<uuid>`; `rawSessionId` folds the
 *   two), and it is what the session id starts with in Claude Code's `/status`
 *   and in daemon logs, so the user can check which key is which.
 * Time-ordered ids (UUIDv7, OpenCode `ses_…`) share a long leading run, so
 * their shortest unique prefix can outgrow a tile and truncate into identical
 * text again. Past `PREFER_PREFIX_MAX` characters the shorter unique TAIL is
 * used instead, written `…<tail>` so it still reads as part of the id.
 * An optional producer displayName replaces the project text only in collision
 * groups. Keep the ID even with a friendly name: titles can collide or truncate.
 *
 * Presentation only — never a routing, folding or identity key.
 */
import { rawSessionId } from './session-utils.js';

/** Presentation hint cap, in Unicode code points; mirrored by D200HLayoutModel. */
export const SESSION_DISPLAY_NAME_MAX_CHARS = 64;
export function normalizeSessionDisplayName(value: unknown): string {
  if (typeof value !== 'string') return '';
  const clean = value.normalize('NFC')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\t\r\n ]+/g, ' ')
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/gu, '')
    .trim();
  return Array.from(clean).slice(0, SESSION_DISPLAY_NAME_MAX_CHARS).join('');
}

/** Missing = unknown/retain; explicit empty = clear. Removed rows stay removed. */
export function retainSessionDisplayNames<T extends { id: string; displayName?: string }>(
  rows: readonly T[], previous: readonly { id: string; displayName?: string }[],
): T[] {
  const old = new Map(previous.map(row => [row.id, row.displayName]));
  return rows.map(row => row.displayName === undefined && old.get(row.id) !== undefined
    ? { ...row, displayName: old.get(row.id) } : row);
}

export interface SessionDeckLabel {
  /** Project name, or the normalized friendly hint in a collision group. */
  name: string;
  /** Short id tag, present only when another visible row shares name + agent. */
  tag?: string;
}

const MIN_TAG_CHARS = 4;
const MAX_TAG_CHARS = 12;
/** A unique prefix up to this long is preferred — it is what `/status` shows. */
const PREFER_PREFIX_MAX = 6;

/** A leading type word (`ses_`, `hermes-`): lowercase letters including at
 *  least one that is not a hex digit, so a uuid that happens to start with
 *  `deadbeef-` is never mistaken for one. */
const TYPE_MARKER = /^[a-z]*[g-z][a-z]*[-_]/;

/** Alphanumeric body of a session id, with transport prefixes removed. */
function idBody(id: string): string {
  const bare = rawSessionId(id);
  const afterScheme = bare.slice(bare.lastIndexOf(':') + 1);
  const withoutKind = afterScheme.replace(TYPE_MARKER, '');
  return withoutKind.replace(/[^0-9A-Za-z]/g, '').toLowerCase();
}

/** Shortest length in [MIN, MAX] at which `cut(body)` is shared by no sibling. */
function uniqueLength(bodies: string[], i: number, cut: (b: string, n: number) => string): number | null {
  const body = bodies[i];
  const cap = Math.min(MAX_TAG_CHARS, body.length);
  for (let len = Math.min(MIN_TAG_CHARS, body.length); len <= cap; len += 1) {
    const mine = cut(body, len);
    if (!bodies.some((other, j) => j !== i && cut(other, len) === mine)) return len;
  }
  return null;
}

function tagFor(bodies: string[], i: number): string {
  const body = bodies[i];
  const prefix = uniqueLength(bodies, i, (b, n) => b.slice(0, n));
  if (prefix != null && prefix <= PREFER_PREFIX_MAX) return body.slice(0, prefix);
  const suffix = uniqueLength(bodies, i, (b, n) => b.slice(-n));
  if (suffix != null && (prefix == null || suffix < prefix)) return `…${body.slice(-suffix)}`;
  return body.slice(0, prefix ?? Math.min(MAX_TAG_CHARS, body.length));
}

function collisionKey(s: { projectName?: string; agentType?: string }): string {
  return `${s.projectName ?? ''}\u0000${s.agentType ?? ''}`;
}

/**
 * Label every session in `sessions` (the deck's whole visible roster, every
 * page — two siblings on different pages must still tell apart). Rows that
 * share `projectName` AND `agentType` get a `tag`; different agents in one
 * project already differ by creature and colour.
 */
export function sessionDeckLabels<T extends { id: string; projectName?: string; agentType?: string; displayName?: string }>(
  sessions: readonly T[],
): Map<string, SessionDeckLabel> {
  const groups = new Map<string, T[]>();
  for (const s of sessions) {
    const key = collisionKey(s);
    const group = groups.get(key);
    if (group) group.push(s); else groups.set(key, [s]);
  }
  const labels = new Map<string, SessionDeckLabel>();
  for (const group of groups.values()) {
    const unique = new Map<string, T>();
    for (const s of group) if (!unique.has(s.id)) unique.set(s.id, s);
    const members = [...unique.values()];
    if (members.length < 2) {
      for (const s of members) labels.set(s.id, { name: s.projectName ?? '' });
      continue;
    }
    const bodies = members.map((s) => idBody(s.id) || s.id.toLowerCase());
    members.forEach((s, i) => {
      labels.set(s.id, { name: normalizeSessionDisplayName(s.displayName) || s.projectName || '', tag: tagFor(bodies, i) });
    });
  }
  return labels;
}

/**
 * One-line text for a label within `maxChars`, keeping the tag whole: the
 * project name gives way first (`chezmoi #5f8f` → `che… #5f8f`). Without a tag
 * the name is returned untouched, so callers' own truncation stays as before.
 * Counts code points, so a non-BMP character (emoji, rare CJK) is never split
 * into a lone surrogate.
 */
export function sessionLabelText(label: SessionDeckLabel | undefined, maxChars?: number): string | undefined {
  if (!label) return undefined;
  if (!label.tag) return label.name;
  const suffix = Array.from(` #${label.tag}`);
  if (maxChars == null || Array.from(label.name).length + suffix.length <= maxChars) return `${label.name} #${label.tag}`;
  // A live cmux title is `<workspace> / <surface>`. Cut from the right, the
  // workspace survives and the surface — the part that tells two tabs of one
  // workspace apart — is lost first (D200X receipt, #544). When the whole label
  // does not fit, keep the segment after the last separator instead.
  const sep = label.name.lastIndexOf(' / ');
  const specific = sep > 0 && sep + 3 < label.name.length ? label.name.slice(sep + 3) : label.name;
  const name = Array.from(specific);
  if (name.length + suffix.length <= maxChars) return `${specific} #${label.tag}`;
  const room = maxChars - suffix.length;
  if (room <= 1) return Array.from(`#${label.tag}`).slice(0, Math.max(1, maxChars)).join('');
  return `${name.slice(0, room - 1).join('').trimEnd()}…${suffix.join('')}`;
}
