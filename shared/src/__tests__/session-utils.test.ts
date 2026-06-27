import { describe, it, expect } from 'vitest';
import {
  agentTypeRank, sortSessions, assignDisplayNames, naturalLabelCompare, foldCodexSessionsForDisplay,
  isOpenClawSessionActive, hasOpenClawSession,
} from '../session-utils.js';
import type { FoldableSession } from '../session-utils.js';

describe('OpenClaw visibility SSOT', () => {
  it('isOpenClawSessionActive is true only when gatewayConnected', () => {
    expect(isOpenClawSessionActive({ gatewayConnected: true })).toBe(true);
    // reachability / health alone must NOT materialize a session
    expect(isOpenClawSessionActive({ gatewayAvailable: true })).toBe(false);
    expect(isOpenClawSessionActive({ gatewayHasError: true })).toBe(false);
    expect(isOpenClawSessionActive({ gatewayAvailable: true, gatewayConnected: false })).toBe(false);
    expect(isOpenClawSessionActive({})).toBe(false);
  });

  it('hasOpenClawSession detects an emitted openclaw session', () => {
    expect(hasOpenClawSession([{ agentType: 'claude-code' }, { agentType: 'openclaw' }])).toBe(true);
    expect(hasOpenClawSession([{ agentType: 'claude-code' }])).toBe(false);
    expect(hasOpenClawSession([])).toBe(false);
  });
});

describe('agentTypeRank', () => {
  it('ranks openclaw first, then claude-code, codex-cli, codex-app, opencode, others', () => {
    expect(agentTypeRank('openclaw')).toBe(0);
    expect(agentTypeRank('claude-code')).toBe(1);
    expect(agentTypeRank('codex-cli')).toBe(2);
    expect(agentTypeRank('codex-app')).toBe(3);
    expect(agentTypeRank('opencode')).toBe(4);
    expect(agentTypeRank('something-else')).toBe(5);
    expect(agentTypeRank(undefined)).toBe(5);
  });
});

describe('naturalLabelCompare', () => {
  it('orders numeric chunks naturally (Agent 2 before Agent 10)', () => {
    expect(naturalLabelCompare('Agent 2', 'Agent 10')).toBeLessThan(0);
    expect(naturalLabelCompare('Agent 10', 'Agent 2')).toBeGreaterThan(0);
    expect(naturalLabelCompare('Agent 2', 'Agent 2')).toBe(0);
  });

  it('treats undefined as empty string', () => {
    expect(naturalLabelCompare(undefined, undefined)).toBe(0);
    expect(naturalLabelCompare(undefined, 'a')).toBeLessThan(0);
  });
});

describe('sortSessions', () => {
  it('places openclaw before claude-code regardless of project', () => {
    const sessions = [
      { id: 'a', agentType: 'claude-code', projectName: 'Z', startedAt: '2026-05-11T10:00:00Z' },
      { id: 'b', agentType: 'openclaw', projectName: 'A', startedAt: '2026-05-11T11:00:00Z' },
    ];
    const sorted = sortSessions(sessions);
    expect(sorted.map(s => s.id)).toEqual(['b', 'a']);
  });

  it('sorts by project name within the same agent type', () => {
    const sessions = [
      { id: 'a', agentType: 'claude-code', projectName: 'Beta', startedAt: '2026-05-11T10:00:00Z' },
      { id: 'b', agentType: 'claude-code', projectName: 'Alpha', startedAt: '2026-05-11T11:00:00Z' },
    ];
    expect(sortSessions(sessions).map(s => s.id)).toEqual(['b', 'a']);
  });

  it('sorts numbered project names naturally (#2 before #10)', () => {
    const sessions = [
      { id: 'a', agentType: 'claude-code', projectName: 'Agent 10' },
      { id: 'b', agentType: 'claude-code', projectName: 'Agent 2' },
    ];
    expect(sortSessions(sessions).map(s => s.id)).toEqual(['b', 'a']);
  });

  it('breaks ties on startedAt ascending (oldest first)', () => {
    const sessions = [
      { id: 'newer', agentType: 'claude-code', projectName: 'AgentDeck', startedAt: '2026-05-11T11:00:00Z' },
      { id: 'older', agentType: 'claude-code', projectName: 'AgentDeck', startedAt: '2026-05-11T10:00:00Z' },
    ];
    expect(sortSessions(sessions).map(s => s.id)).toEqual(['older', 'newer']);
  });

  it('falls back to id natural-compare when startedAt ties to the same ms', () => {
    const sameTs = '2026-05-11T10:00:00Z';
    const sessions = [
      { id: 'session-10', agentType: 'claude-code', projectName: 'AgentDeck', startedAt: sameTs },
      { id: 'session-2', agentType: 'claude-code', projectName: 'AgentDeck', startedAt: sameTs },
    ];
    // session-2 < session-10 under numeric-aware compare
    expect(sortSessions(sessions).map(s => s.id)).toEqual(['session-2', 'session-10']);
  });

  it('does not mutate the input array', () => {
    const sessions = [
      { id: 'b', agentType: 'claude-code', projectName: 'B' },
      { id: 'a', agentType: 'claude-code', projectName: 'A' },
    ];
    const snapshot = sessions.map(s => s.id);
    sortSessions(sessions);
    expect(sessions.map(s => s.id)).toEqual(snapshot);
  });
});

describe('foldCodexSessionsForDisplay', () => {
  it('folds Codex CLI and Codex App separately even with the same project', () => {
    const sessions: FoldableSession[] = [
      { id: 'codex:cli', projectName: 'AgentDeck', agentType: 'codex-cli', state: 'processing' },
      { id: 'codex:app-1', projectName: 'AgentDeck', agentType: 'codex-app', state: 'processing' },
      { id: 'codex:app-2', projectName: 'AgentDeck', agentType: 'codex-app', state: 'idle' },
    ];
    const folded = foldCodexSessionsForDisplay(sessions);

    expect(folded).toHaveLength(2);
    expect(folded.map(s => s.id).sort()).toEqual(['codex:app-1', 'codex:cli']);
    expect(folded.find(s => s.agentType === 'codex-app')?.groupSize).toBe(2);
  });
});

describe('assignDisplayNames', () => {
  it('passes single sessions through without #N suffix', () => {
    const sessions = [
      { id: 'a', projectName: 'AgentDeck', agentType: 'claude-code' },
      { id: 'b', projectName: 'OpenClaw', agentType: 'openclaw' },
    ];
    const named = assignDisplayNames(sessions);
    expect(named.map(d => d.displayName)).toEqual(['AgentDeck', 'OpenClaw']);
  });

  it('adds #1/#2 suffixes for duplicate (project, agentType) tuples in input order', () => {
    // Input order matters — assignDisplayNames does not re-sort. Caller must
    // sort first. We feed sortSessions output to mimic the real pipeline.
    const sessions = sortSessions([
      { id: 'older', projectName: 'AgentDeck', agentType: 'claude-code', startedAt: '2026-05-11T10:00:00Z' },
      { id: 'newer', projectName: 'AgentDeck', agentType: 'claude-code', startedAt: '2026-05-11T11:00:00Z' },
    ]);
    const named = assignDisplayNames(sessions);
    expect(named.map(d => `${d.session.id}=${d.displayName}`)).toEqual([
      'older=AgentDeck #1',
      'newer=AgentDeck #2',
    ]);
  });

  it('numbers same project across different agentTypes independently', () => {
    const sessions = sortSessions([
      { id: 'a', projectName: 'AgentDeck', agentType: 'claude-code', startedAt: '2026-05-11T10:00:00Z' },
      { id: 'b', projectName: 'AgentDeck', agentType: 'codex-cli', startedAt: '2026-05-11T10:00:00Z' },
      { id: 'c', projectName: 'AgentDeck', agentType: 'claude-code', startedAt: '2026-05-11T11:00:00Z' },
    ]);
    const named = assignDisplayNames(sessions);
    // claude-code AgentDeck appears twice → #1/#2; codex-cli AgentDeck is solo → no suffix
    const map = Object.fromEntries(named.map(d => [d.session.id, d.displayName]));
    expect(map.a).toBe('AgentDeck #1');
    expect(map.c).toBe('AgentDeck #2');
    expect(map.b).toBe('AgentDeck');
  });

  it('produces the same #N assignment as a deterministic sort + display pipeline', () => {
    // Cross-platform invariant: sortSessions output is the only thing
    // assignDisplayNames depends on. So as long as every surface feeds the
    // same input through sortSessions first, #N suffixes match.
    const raw = [
      { id: 'session-10', projectName: 'AgentDeck', agentType: 'claude-code', startedAt: '2026-05-11T10:00:00Z' },
      { id: 'session-2', projectName: 'AgentDeck', agentType: 'claude-code', startedAt: '2026-05-11T10:00:00Z' },
      { id: 'session-1', projectName: 'AgentDeck', agentType: 'openclaw', startedAt: '2026-05-11T09:00:00Z' },
    ];
    // Run twice with two different input shuffles — output must match.
    const a = assignDisplayNames(sortSessions([...raw].reverse()));
    const b = assignDisplayNames(sortSessions(raw));
    expect(a.map(d => `${d.session.id}=${d.displayName}`)).toEqual(
      b.map(d => `${d.session.id}=${d.displayName}`),
    );
    // openclaw row first (rank=0), then natural-id-sorted claude-code rows
    expect(b.map(d => d.session.id)).toEqual(['session-1', 'session-2', 'session-10']);
  });
});
