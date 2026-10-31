/** Cold continuity is ordered by one local transaction log, never wall-clock time. */
export const DAEMON_RECOVERY_POLICY = {
  version: 1, file: 'agentdeck-recovery.sqlite', cursorFile: 'daemon-recovery-cursor.json', locationFile: 'daemon-recovery-location.json',
  folderName: 'AgentDeck Recovery', consentFile: 'recovery-consent.json',
  busyTimeoutMs: 250, maxRevision: Number.MAX_SAFE_INTEGER,
  schema: 'CREATE TABLE IF NOT EXISTS recovery_head (singleton INTEGER PRIMARY KEY CHECK(singleton=1), store_id TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL);',
} as const;
