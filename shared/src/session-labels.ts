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
 * - it never changes for the life of a session, unlike a `#N` ordinal, which
 *   renumbers when an older sibling ends;
 * - both daemons emit it (the Swift daemon keys an observed Claude session on
 *   the bare uuid, Node on `observed:claude:<uuid>`; `rawSessionId` folds the
 *   two), and it is what the session id starts with in Claude Code's `/status`
 *   and in daemon logs, so the user can check which key is which.
 * Richer hints (terminal tab title, `claude --name`, git branch) are not on the
 * session row from either daemon today; they would need producer work first.
 *
 * Presentation only — never a routing, folding or identity key.
 */
import { rawSessionId } from './session-utils.js';

export interface SessionDeckLabel {
  /** The session's project name, unchanged. */
  name: string;
  /** Short id tag, present only when another visible row shares name + agent. */
  tag?: string;
}

const MIN_TAG_CHARS = 4;
const MAX_TAG_CHARS = 12;

/** Alphanumeric body of a session id, with transport prefixes removed. */
function idBody(id: string): string {
  const bare = rawSessionId(id);
  const afterScheme = bare.slice(bare.lastIndexOf(':') + 1);
  // OpenCode-style `ses_<…>` ids: the word before `_` is a type marker, not identity.
  const withoutKind = afterScheme.replace(/^[a-z]+_/, '');
  return withoutKind.replace(/[^0-9A-Za-z]/g, '').toLowerCase();
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
export function sessionDeckLabels<T extends { id: string; projectName?: string; agentType?: string }>(
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
      const body = bodies[i];
      let len = Math.min(MIN_TAG_CHARS, body.length);
      // Grow until no sibling shares the prefix. Time-ordered ids (UUIDv7,
      // OpenCode) share a long leading run, so a fixed width would collide.
      while (len < Math.min(MAX_TAG_CHARS, body.length)
        && bodies.some((other, j) => j !== i && other.startsWith(body.slice(0, len)))) {
        len += 1;
      }
      labels.set(s.id, { name: s.projectName ?? '', tag: body.slice(0, len) });
    });
  }
  return labels;
}

/**
 * One-line text for a label within `maxChars`, keeping the tag whole: the
 * project name gives way first (`chezmoi #5f8f` → `che… #5f8f`). Without a tag
 * the name is returned untouched, so callers' own truncation stays as before.
 */
export function sessionLabelText(label: SessionDeckLabel | undefined, maxChars?: number): string | undefined {
  if (!label) return undefined;
  if (!label.tag) return label.name;
  const suffix = ` #${label.tag}`;
  const full = `${label.name}${suffix}`;
  if (maxChars == null || full.length <= maxChars) return full;
  const room = maxChars - suffix.length;
  if (room <= 1) return `#${label.tag}`.slice(0, Math.max(1, maxChars));
  return `${label.name.slice(0, room - 1).trimEnd()}…${suffix}`;
}
