import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawn } from 'child_process';
import type { EventJournal } from './event-journal.js';
import type { PtyRingBuffer } from './pty-ringbuffer.js';
import type { StateMachine } from './state-machine.js';
import type { WsServer } from './ws-server.js';
import { debug } from './logger.js';

const DIAG_DIR = join(homedir(), '.agentdeck', 'diag');
const MAX_DIAG_FILES = 10;
const AI_TIMEOUT_MS = 30_000;

export interface DiagDump {
  timestamp: string;
  sessionInfo: {
    state: string;
    permissionMode: string;
    suggestedPrompt: string | null;
    lastValidSuggestedPrompt: string | null;
    projectName: string | null;
    modelName: string | null;
    billingType: string;
  };
  wsClients: number;
  recentJournal: string[];  // last N lines from journal
  ptyTail: string;          // last 32KB of PTY output
  journalDir: string;
}

/** Create a diagnostic dump from current system state */
export function createDiagDump(
  stateMachine: StateMachine,
  wsServer: WsServer,
  journal: EventJournal,
  ringBuffer: PtyRingBuffer,
  tailLines = 200,
): DiagDump {
  const snapshot = stateMachine.getSnapshot();

  // Read recent journal entries
  const journalPath = journal.getCurrentFilePath();
  let recentJournal: string[] = [];
  try {
    if (existsSync(journalPath)) {
      const content = readFileSync(journalPath, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      recentJournal = lines.slice(-tailLines);
    }
  } catch {
    // ignore
  }

  return {
    timestamp: new Date().toISOString(),
    sessionInfo: {
      state: snapshot.state,
      permissionMode: snapshot.permissionMode,
      suggestedPrompt: snapshot.suggestedPrompt,
      lastValidSuggestedPrompt: stateMachine.getLastValidSuggestedPrompt(),
      projectName: snapshot.projectName,
      modelName: snapshot.modelName,
      billingType: snapshot.billingType,
    },
    wsClients: wsServer.getClientCount(),
    recentJournal,
    ptyTail: ringBuffer.getTail(32 * 1024),
    journalDir: journal.getJournalDir(),
  };
}

/** Save a diagnostic dump to disk, return the file path */
export function saveDiagDump(dump: DiagDump): string {
  mkdirSync(DIAG_DIR, { recursive: true });

  // Prune old dump files
  try {
    const files = readdirSync(DIAG_DIR)
      .filter(f => f.startsWith('dump-') && f.endsWith('.json'))
      .sort()
      .reverse();
    for (const f of files.slice(MAX_DIAG_FILES)) {
      try {
        unlinkSync(join(DIAG_DIR, f));
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }

  const ts = Date.now();
  const filePath = join(DIAG_DIR, `dump-${ts}.json`);
  writeFileSync(filePath, JSON.stringify(dump, null, 2));
  debug('Diag', `Dump saved: ${filePath}`);
  return filePath;
}

/** Run AI analysis on a dump file using claude -p --model haiku */
export function analyzeDump(dumpPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    let dumpContent: string;
    try {
      dumpContent = readFileSync(dumpPath, 'utf-8');
    } catch (err) {
      debug('Diag', `Failed to read dump: ${err}`);
      resolve(null);
      return;
    }

    // Truncate if too large for Haiku context
    if (dumpContent.length > 50000) {
      dumpContent = dumpContent.slice(0, 50000) + '\n... (truncated)';
    }

    const systemPrompt = `You are a diagnostic assistant for AgentDeck, a Stream Deck+ controller for Claude Code CLI.

Analyze this diagnostic dump and identify:
1. Abnormal state transitions (e.g., stuck states, unexpected DISCONNECTED)
2. WebSocket connectivity issues (0 clients receiving broadcasts)
3. Parser false positives or missed events
4. Ghost text / suggested prompt detection failures
5. Any errors or warnings

For each issue found, provide:
- What happened (with timestamps)
- Root cause assessment
- Suggested fix

If everything looks normal, say so.`;

    // Use stdin pipe to avoid OS argument length limits with large dumps
    const proc = spawn('claude', ['-p', '--model', 'haiku', systemPrompt], {
      timeout: AI_TIMEOUT_MS,
      env: { ...process.env, NO_COLOR: '1', CLAUDECODE: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('error', (err) => {
      debug('Diag', `AI analysis spawn error: ${err.message}`);
      resolve(null);
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        debug('Diag', `AI analysis exited ${code}: ${stderr.slice(0, 200)}`);
        resolve(null);
        return;
      }
      const analysis = stdout.trim();
      if (!analysis) {
        resolve(null);
        return;
      }

      // Save analysis alongside dump
      const analysisPath = dumpPath.replace(/dump-(\d+)\.json$/, 'analysis-$1.md');
      try {
        writeFileSync(analysisPath, analysis);
        debug('Diag', `Analysis saved: ${analysisPath}`);
      } catch {
        // ignore save failure, still return content
      }

      resolve(analysis);
    });

    // Feed dump content via stdin
    proc.stdin.write(`Diagnostic dump:\n${dumpContent}`);
    proc.stdin.end();
  });
}

/** Get diagnostic directory path */
export function getDiagDir(): string {
  return DIAG_DIR;
}
