import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Keep test runs hermetic. Several modules discover a live AgentDeck daemon by
// reading AGENTDECK_DATA_DIR plus App Store container fallbacks; using a temp
// data dir prevents local app state from affecting Vitest.
const dataDir = mkdtempSync(join(tmpdir(), 'agentdeck-vitest-'));
process.env.AGENTDECK_DATA_DIR = dataDir;

// Pin TZ so timeline-renderer snapshots are stable regardless of host TZ.
// CI sets this via env (Asia/Seoul); pinning here covers local dev across
// macOS, Linux, and Windows without each contributor having to set TZ.
process.env.TZ = 'Asia/Seoul';

process.once('exit', () => {
  rmSync(dataDir, { recursive: true, force: true });
});
