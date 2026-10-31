/** Cold continuity is ordered by one local transaction log, never wall-clock time. */
export const DAEMON_RECOVERY_POLICY = {
  version: 1, schemaVersion: 2, maxConflicts: 64, file: 'agentdeck-recovery.sqlite', cursorFile: 'daemon-recovery-cursor.json', locationFile: 'daemon-recovery-location.json',
  folderName: 'AgentDeck Recovery', consentFile: 'recovery-consent.json',
  busyTimeoutMs: 250, maxRevision: Number.MAX_SAFE_INTEGER,
  schema: 'CREATE TABLE IF NOT EXISTS recovery_head (singleton INTEGER PRIMARY KEY CHECK(singleton=1), store_id TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS recovery_conflicts (profile TEXT PRIMARY KEY, runtime TEXT NOT NULL, local_digest TEXT NOT NULL, snapshot TEXT NOT NULL); CREATE TABLE IF NOT EXISTS recovery_resolutions (id TEXT PRIMARY KEY, store_id TEXT NOT NULL, profile TEXT NOT NULL, local_digest TEXT NOT NULL, revision INTEGER NOT NULL, choice TEXT NOT NULL, local_payload TEXT NOT NULL, prior_payload TEXT NOT NULL, applied INTEGER NOT NULL DEFAULT 0);',
  preservedFiles: ['daemon-checkpoint.json', 'daemon-checkpoint-peer.json', 'session-order.json', 'pocket-autonomy.json', 'daemon-recovery-cursor.json'],
} as const;
