import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildKiroDiagnosticReport, formatKiroDiagnosticReport } from '../kiro-diagnostics.js';
import {
  applyKiroPendingTurnMarker,
  kiroTranscriptRecordKinds,
  parseKiroTranscript,
  parseKiroSqliteRows,
  readKiroV3SessionSnapshots,
  type KiroSessionSnapshot,
} from '../kiro-session.js';

const NOW = Date.parse('2026-08-15T12:00:00.000Z');

function snapshot(overrides: Partial<KiroSessionSnapshot> = {}): KiroSessionSnapshot {
  return {
    sessionId: 'raw-session-id',
    transcriptPath: '/Users/alice/.kiro/sessions/cli/raw-session-id.jsonl',
    cwd: '/Users/alice/work/secret-project',
    title: 'secret title',
    modelName: 'secret-model-name',
    createdAt: NOW - 120_000,
    updatedAt: NOW - 1_000,
    lastActivityAt: NOW - 1_000,
    state: 'processing',
    goal: 'secret prompt body',
    currentTask: 'curl bearer secret-command-token',
    response: 'secret response body',
    recordKinds: ['Prompt', 'AssistantMessage'],
    ...overrides,
  };
}

describe('Kiro privacy-safe diagnostics', () => {
  it('correlates an explicit resume id without serializing content, paths, ids, or commands', () => {
    const report = buildKiroDiagnosticReport({
      processes: [
        {
          pid: 707,
          ppid: 1,
          rssKb: 1024,
          tty: 'ttys-secret',
          command: '/Users/alice/.local/bin/kiro-cli --v3 --resume-id raw-session-id --prompt command-secret',
        },
      ],
      snapshots: [snapshot({ recordKinds: ['Prompt', 'AssistantMessage', 'schema-secret'] })],
      cwdByPid: new Map([[707, '/Users/alice/work/secret-project']]),
      totalConversationRecords: 1,
      directoryPresent: true,
      primaryStore: 'jsonl-legacy',
      now: NOW,
      platform: 'darwin',
      salt: 'test-only-salt',
    });

    expect(report.processes).toMatchObject({ total: 1, cli: 1, ide: 0 });
    expect(report.processes.entries[0]).toMatchObject({
      surface: 'cli',
      ttyAttached: true,
      cwdKnown: true,
      v3Flag: true,
      resumeIdFlag: true,
    });
    expect(report.correlations[0]).toMatchObject({
      matchedSession: true,
      confidence: 'exact-resume-id',
      state: 'processing',
    });
    expect(report.sessions.entries[0]).toMatchObject({
      format: 'v2',
      ageSeconds: 1,
      recordKinds: ['AssistantMessage', 'Prompt', 'other'],
      hasModel: true,
    });
    expect(report.sessions.entries[0].sessionKey).toMatch(/^sid-[a-f0-9]{12}$/);
    expect(report.sessions.entries[0].cwdKey).toMatch(/^cwd-[a-f0-9]{12}$/);

    const serialized = JSON.stringify(report);
    for (const secret of [
      '/Users/alice',
      'secret-project',
      'raw-session-id',
      'secret title',
      'secret-model-name',
      'secret prompt body',
      'secret-command-token',
      'secret response body',
      'command-secret',
      'ttys-secret',
      'schema-secret',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('distinguishes cwd correlation, ACP records, and process-only IDE observation', () => {
    const report = buildKiroDiagnosticReport({
      processes: [
        { pid: 801, ppid: 1, rssKb: 10, tty: 'ttys001', command: '/opt/bin/kiro-cli' },
        {
          pid: 802,
          ppid: 1,
          rssKb: 20,
          command: '/Applications/Kiro.app/Contents/MacOS/Kiro',
        },
      ],
      snapshots: [
        snapshot({
          sessionId: 'acp-session',
          state: 'idle',
          recordKinds: ['session/prompt', 'session/notification:TurnEnd'],
        }),
      ],
      cwdByPid: new Map([
        [801, '/Users/alice/work/secret-project'],
        [802, '/Users/alice/work/other-project'],
      ]),
      totalConversationRecords: 1,
      directoryPresent: true,
      primaryStore: 'jsonl-legacy',
      now: NOW,
      salt: 'test-only-salt',
    });

    expect(report.processes).toMatchObject({ total: 2, cli: 1, ide: 1 });
    expect(report.sessions.entries[0].format).toBe('acp');
    expect(report.correlations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pid: 801, confidence: 'cwd-newest', matchedSession: true }),
        expect.objectContaining({ pid: 802, confidence: 'ide-process-only', matchedSession: false }),
      ]),
    );
  });

  it('reports missing prerequisites without treating them as a command failure', () => {
    const report = buildKiroDiagnosticReport({
      processes: [],
      snapshots: [],
      totalConversationRecords: 0,
      directoryPresent: false,
      sqliteDatabasePresent: false,
      sqliteReadable: false,
      primaryStore: 'none',
      now: NOW,
      salt: 'test-only-salt',
    });

    expect(report.correlations).toEqual([]);
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('No running Kiro process'),
        expect.stringContaining('No supported Kiro conversation store'),
      ]),
    );
    expect(formatKiroDiagnosticReport(report)).toContain('Kiro diagnostic (privacy-safe)');
  });

  it('only exposes allowlisted transcript schema markers', () => {
    const raw = [
      JSON.stringify({ kind: 'Prompt', data: { content: [] } }),
      JSON.stringify({ kind: 'prompt-body-that-must-not-leak', data: {} }),
      JSON.stringify({
        method: 'session/notification',
        params: {
          update: { sessionUpdate: 'ToolCall', input: { token: 'also-secret' } },
        },
      }),
      JSON.stringify({ method: 'method-secret', params: {} }),
    ].join('\n');

    expect(kiroTranscriptRecordKinds(raw)).toEqual([
      'Prompt',
      'other',
      'session/notification',
      'session/notification:ToolCall',
    ]);
  });

  it('summarizes measured v3 message envelopes and recognizes completed turns', () => {
    const raw = [
      JSON.stringify({ id: '1', timestamp: '2026-08-15T00:00:00Z', payload: { type: 'user', content: 'secret prompt' } }),
      JSON.stringify({ id: '2', timestamp: '2026-08-15T00:00:01Z', payload: { type: 'turn_start', executionId: 'secret' } }),
      JSON.stringify({ id: '3', timestamp: '2026-08-15T00:00:02Z', payload: { type: 'assistant', content: 'secret response' } }),
      JSON.stringify({ id: '4', timestamp: '2026-08-15T00:00:03Z', payload: { type: 'turn_end', executionId: 'secret' } }),
    ].join('\n');

    const kinds = kiroTranscriptRecordKinds(raw);
    expect(kinds).toEqual(['assistant', 'turn_end', 'turn_start', 'user']);
    expect(parseKiroTranscript(raw)).toMatchObject({
      state: 'idle',
      goal: 'secret prompt',
      response: 'secret response',
    });
    expect(parseKiroTranscript(raw.split('\n').slice(0, 3).join('\n')).state).toBe('processing');
    const report = buildKiroDiagnosticReport({
      processes: [],
      snapshots: [snapshot({ recordKinds: kinds, state: 'idle' })],
      v3DirectoryPresent: true,
      directoryPresent: false,
      primaryStore: 'jsonl-v3',
      now: NOW,
      salt: 'test-only-salt',
    });
    expect(report.sessions.entries[0]).toMatchObject({ format: 'v3', state: 'idle' });
    expect(JSON.stringify(report)).not.toContain('secret prompt');
    expect(JSON.stringify(report)).not.toContain('secret response');
  });

  // A real v3 turn ends with a SECOND `assistant` record — `operationType:
  // "Reasoning"`, content already redacted by Kiro to a literal "..." — and the
  // newest assistant record wins. The fixture above has a single unqualified
  // assistant record, which is why it passed while every real session came out
  // with response === "...". Measured against 6 live transcripts on 2026-08-16.
  it('takes the spoken reply, not the trailing redacted Reasoning block', () => {
    const raw = [
      JSON.stringify({ id: '1', timestamp: '2026-08-15T00:00:00Z', payload: { type: 'user', content: 'secret prompt' } }),
      JSON.stringify({ id: '2', timestamp: '2026-08-15T00:00:01Z', payload: { type: 'turn_start', executionId: 'secret' } }),
      JSON.stringify({
        id: '3',
        timestamp: '2026-08-15T00:00:02Z',
        payload: { type: 'assistant', operationType: 'Say', content: 'the actual answer', executionId: 'secret' },
      }),
      JSON.stringify({
        id: '4',
        timestamp: '2026-08-15T00:00:03Z',
        payload: {
          type: 'assistant',
          operationType: 'Reasoning',
          content: '...',
          reasoningSignature: 'secret-signature',
          reasoningModelId: 'qdev::auto',
        },
      }),
      JSON.stringify({ id: '5', timestamp: '2026-08-15T00:00:04Z', payload: { type: 'turn_end', executionId: 'secret' } }),
    ].join('\n');

    const summary = parseKiroTranscript(raw);
    expect(summary.response).toBe('the actual answer');
    expect(summary.state).toBe('idle');
    // The reasoning block contributes nothing — neither its placeholder nor,
    // should Kiro ever stop redacting it, its content.
    expect(summary.response).not.toContain('...');
    expect(JSON.stringify(summary)).not.toContain('secret-signature');
  });

  it('discovers the measured v3 workspace/session directory layout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentdeck-kiro-v3-'));
    const sessionDir = join(root, 'workspace-hash', 'sess_test-v3');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({
      id: 'sess_test-v3',
      title: 'secret title',
      workspacePaths: ['/Users/alice/work/secret-project'],
      createdAt: '2026-08-15T11:58:00.000Z',
      lastModifiedAt: '2026-08-15T11:59:59.000Z',
      modelId: 'secret-model',
    }));
    writeFileSync(join(sessionDir, 'messages.jsonl'), [
      JSON.stringify({ payload: { type: 'user', content: 'secret prompt' } }),
      JSON.stringify({ payload: { type: 'turn_start' } }),
    ].join('\n'));
    try {
      const snapshots = await readKiroV3SessionSnapshots(root);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({
        sessionId: 'sess_test-v3',
        cwd: '/Users/alice/work/secret-project',
        modelName: 'secret-model',
        state: 'processing',
        recordKinds: ['turn_start', 'user'],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('projects measured SQLite v2 rows and recognizes their schema marker', () => {
    const snapshots = parseKiroSqliteRows([
      {
        cwd: '/Users/alice/work/secret-project',
        sessionId: 'sqlite-session',
        createdAt: NOW - 60_000,
        updatedAt: NOW - 1_000,
        modelName: 'secret-model-name',
        goal: 'secret prompt body',
        response: 'secret response body',
        historyCount: 2,
        hasAssistant: 1,
      },
    ], '/Users/alice/Library/Application Support/kiro-cli/data.sqlite3');
    const report = buildKiroDiagnosticReport({
      processes: [{ pid: 901, ppid: 1, rssKb: 10, command: '/opt/bin/kiro-cli-chat chat' }],
      snapshots,
      cwdByPid: new Map([[901, '/Users/alice/work/secret-project']]),
      totalConversationRecords: 1,
      directoryPresent: false,
      sqliteDatabasePresent: true,
      sqliteReadable: true,
      primaryStore: 'sqlite-v2',
      now: NOW,
      salt: 'test-only-salt',
    });

    expect(report.config).toMatchObject({
      primaryStore: 'sqlite-v2',
      sqliteDatabasePresent: true,
      sqliteReadable: true,
      directoryPresent: false,
    });
    expect(report.sessions.entries[0]).toMatchObject({
      format: 'v2',
      recordKinds: ['AssistantMessage', 'ConversationV2', 'Prompt'],
    });
    expect(report.findings).toContain('Kiro passive observation prerequisites look healthy.');
    expect(JSON.stringify(report)).not.toContain('secret prompt body');
    expect(JSON.stringify(report)).not.toContain('/Users/alice');
  });

  it('uses prompt-history mtime as a content-free pending-turn marker', () => {
    const base = snapshot({ state: 'idle', lastActivityAt: NOW - 2_000 });
    expect(applyKiroPendingTurnMarker([base], NOW - 1_000, NOW)[0]).toMatchObject({
      state: 'processing',
      lastActivityAt: NOW - 1_000,
    });
    expect(applyKiroPendingTurnMarker([base], NOW - 3_000, NOW)[0].state).toBe('idle');
    expect(applyKiroPendingTurnMarker([base], NOW - 11 * 60_000, NOW)[0].state).toBe('idle');
  });
});
