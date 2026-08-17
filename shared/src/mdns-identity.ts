/**
 * How a daemon names itself on `_agentdeck._tcp`, and how a client tells one
 * daemon's advertisement from another's.
 *
 * A DNS-SD instance name must be unique **per network segment**, not per host.
 * Both daemons published `${project}-${port}` — literally `AgentDeck-9120` on
 * every machine — so on an office subnet fifty daemons fought over one name.
 * The Node side does not rename on conflict: it treats "already in use on the
 * network" as non-fatal, destroys the responder, and the 5-second recovery
 * timer republishes it, forever. The result is a permanent republish storm and
 * no daemon that stays reliably resolvable (docs/ENTERPRISE-ROADMAP.md §2.1).
 *
 * There is prior art for how badly naming goes wrong here: issue #67, where the
 * responder's HOSTNAME claim renamed users' Macs. `MDNS_SERVICE_HOST` was made
 * process-unique for exactly that reason; the instance name never got the same
 * treatment.
 *
 * The name identifies host, user and port, because those are the three ways two
 * daemons on one segment can legitimately differ. The user is a short hash, not
 * an account name — the segment does not need to learn who is logged in where,
 * and multicast is readable by everyone on it.
 *
 * This is the SSOT for both daemons; the Swift mirror is generated
 * (`pnpm generate-mdns-identity`, drift-gated in
 * `shared/src/__tests__/mdns-identity.test.ts`).
 */

/** TXT schema version, in lockstep between the Node and Swift daemons.
 *  Unchanged by the host/user keys below: no reader validates the key SET (the
 *  ESP32 walks the record looking for `agent` and `project`), so additive keys
 *  are readable by every existing client, and bumping would be a compatibility
 *  event with no compatibility problem to solve. */
export const MDNS_TXT_SCHEMA_VERSION = '3';

/** Longest host label kept in the instance name. DNS-SD allows 63 bytes for
 *  the whole instance name, and it also has to hold the project, the user tag
 *  and the port. */
export const MDNS_HOST_LABEL_MAX = 20;

/**
 * Reduce a string to characters that are safe and readable in a DNS-SD
 * instance label. The spec permits far more than this — the point is not
 * escaping rules but that the name stays greppable in `dns-sd -B` output and
 * cannot collide by way of some client's normalization.
 */
export function sanitizeMdnsLabel(raw: string, maxLength = MDNS_HOST_LABEL_MAX): string {
  const cleaned = (raw || '')
    .split('.')[0]                    // `mac.local` / FQDN → the short name
    .replace(/[^A-Za-z0-9-]+/g, '-')  // spaces, apostrophes ("Sam's MacBook")
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned.slice(0, maxLength);
}

/**
 * Short, stable, non-reversible tag for the OS user a daemon runs as.
 *
 * FNV-1a rather than a crypto hash so the Swift mirror is a dozen lines with no
 * framework import, and because this is a disambiguator, not a secret: it only
 * has to distinguish the handful of accounts on one machine, and it must never
 * be the account name itself, which multicast would then publish to the whole
 * segment.
 */
export function mdnsUserTag(uid: number, username = ''): string {
  let hash = 0x811c9dc5;
  const input = `${uid}:${username}`;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i) & 0xff;
    // FNV prime 16777619, kept in 32-bit range via Math.imul.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0').slice(0, 4);
}

/**
 * The instance name a daemon publishes.
 *
 * Every component is optional-safe: an empty hostname or user tag collapses to
 * the old `${project}-${port}` shape rather than producing `AgentDeck--9120`,
 * so a platform that cannot answer one of the questions degrades to today's
 * behaviour instead of a malformed name.
 */
export function buildMdnsInstanceName(opts: {
  project: string;
  hostname?: string;
  userTag?: string;
  port: number;
}): string {
  const host = sanitizeMdnsLabel(opts.hostname ?? '');
  const user = sanitizeMdnsLabel(opts.userTag ?? '', 8);
  return [opts.project, host, user, String(opts.port)].filter(Boolean).join('-');
}
