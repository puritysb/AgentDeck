import { describe, it, expect } from 'vitest';
import {
  agentTypeRank, sortSessions, assignDisplayNames, naturalLabelCompare, foldCodexSessionsForDisplay,
  isOpenClawSessionActive, hasOpenClawSession, rawSessionId, sameSession, sessionWeight,
  sanitizeWeightForWire, SESSION_WEIGHT_MIN, SESSION_WEIGHT_MAX,
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
  it('ranks openclaw first, then claude-code, codex-cli, codex-app, opencode, antigravity, others', () => {
    expect(agentTypeRank('openclaw')).toBe(0);
    expect(agentTypeRank('claude-code')).toBe(1);
    expect(agentTypeRank('codex-cli')).toBe(2);
    expect(agentTypeRank('codex-app')).toBe(3);
    expect(agentTypeRank('opencode')).toBe(4);
    expect(agentTypeRank('antigravity')).toBe(5);
    expect(agentTypeRank('something-else')).toBe(6);
    expect(agentTypeRank(undefined)).toBe(6);
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

describe('sessionWeight', () => {
  it('returns the weight when it is a finite number (incl. negatives and 0)', () => {
    expect(sessionWeight(0)).toBe(0);
    expect(sessionWeight(3)).toBe(3);
    expect(sessionWeight(-5)).toBe(-5);
  });

  it('collapses missing / null / non-finite weights to 0', () => {
    expect(sessionWeight(undefined)).toBe(0);
    expect(sessionWeight(null)).toBe(0);
    expect(sessionWeight(NaN)).toBe(0);
    expect(sessionWeight(Infinity)).toBe(0);
  });

  it('accepts both documented bounds unchanged', () => {
    expect(sessionWeight(SESSION_WEIGHT_MIN)).toBe(SESSION_WEIGHT_MIN);
    expect(sessionWeight(SESSION_WEIGHT_MAX)).toBe(SESSION_WEIGHT_MAX);
  });

  it('clamps out-of-range values to the documented bounds', () => {
    expect(sessionWeight(SESSION_WEIGHT_MAX + 1)).toBe(SESSION_WEIGHT_MAX);
    expect(sessionWeight(SESSION_WEIGHT_MIN - 1)).toBe(SESSION_WEIGHT_MIN);
    expect(sessionWeight(1e100)).toBe(SESSION_WEIGHT_MAX);
    expect(sessionWeight(-1e100)).toBe(SESSION_WEIGHT_MIN);
    expect(sessionWeight(9007199254740992)).toBe(SESSION_WEIGHT_MAX);
  });

  it('integer-truncates fractional values so all platform mirrors agree', () => {
    expect(sessionWeight(2.5)).toBe(2);
    expect(sessionWeight(-2.5)).toBe(-2);
  });
});

describe('sanitizeWeightForWire', () => {
  it('drops non-numbers and non-finite values to undefined (wire omits the key)', () => {
    expect(sanitizeWeightForWire(undefined)).toBeUndefined();
    expect(sanitizeWeightForWire(null)).toBeUndefined();
    expect(sanitizeWeightForWire('7')).toBeUndefined();
    expect(sanitizeWeightForWire(NaN)).toBeUndefined();
    expect(sanitizeWeightForWire(Infinity)).toBeUndefined();
  });

  it('passes in-range integers and clamps/truncates the rest', () => {
    expect(sanitizeWeightForWire(3)).toBe(3);
    expect(sanitizeWeightForWire(-3)).toBe(-3);
    expect(sanitizeWeightForWire(2 ** 40)).toBe(SESSION_WEIGHT_MAX);
    expect(sanitizeWeightForWire(-(2 ** 40))).toBe(SESSION_WEIGHT_MIN);
    expect(sanitizeWeightForWire(1.9)).toBe(1);
  });
});

describe('sortSessions weight comparator safety', () => {
  it('orders opposite-sign extreme in-range weights without overflow tricks', () => {
    const sessions = [
      { id: 'max', agentType: 'claude-code', projectName: 'A', weight: SESSION_WEIGHT_MAX },
      { id: 'min', agentType: 'claude-code', projectName: 'A', weight: SESSION_WEIGHT_MIN },
      { id: 'zero', agentType: 'claude-code', projectName: 'A' },
    ];
    expect(sortSessions(sessions).map(s => s.id)).toEqual(['min', 'zero', 'max']);
  });
});

describe('sortSessions weight override', () => {
  it('orders by weight ascending: negatives, then unweighted/0, then positives', () => {
    const sessions = [
      { id: 'pos2', agentType: 'claude-code', projectName: 'A', weight: 2 },
      { id: 'neg5', agentType: 'claude-code', projectName: 'A', weight: -5 },
      { id: 'zero', agentType: 'claude-code', projectName: 'A', weight: 0 },
      { id: 'neg3', agentType: 'claude-code', projectName: 'A', weight: -3 },
      { id: 'pos1', agentType: 'claude-code', projectName: 'A', weight: 1 },
    ];
    expect(sortSessions(sessions).map(s => s.id)).toEqual(['neg5', 'neg3', 'zero', 'pos1', 'pos2']);
  });

  it('treats an unweighted session the same as weight 0', () => {
    const sessions = [
      { id: 'pos', agentType: 'claude-code', projectName: 'A', weight: 1 },
      { id: 'none', agentType: 'claude-code', projectName: 'A' },
      { id: 'neg', agentType: 'claude-code', projectName: 'A', weight: -1 },
    ];
    expect(sortSessions(sessions).map(s => s.id)).toEqual(['neg', 'none', 'pos']);
  });

  it('weight beats agentType — a weighted claude-code sorts before an unweighted openclaw', () => {
    const sessions = [
      { id: 'oc', agentType: 'openclaw', projectName: 'A' },
      { id: 'cc', agentType: 'claude-code', projectName: 'A', weight: -1 },
    ];
    expect(sortSessions(sessions).map(s => s.id)).toEqual(['cc', 'oc']);
  });

  it('within the same weight, existing ordering (agentType → project → startedAt → id) still applies', () => {
    const sessions = [
      { id: 'b', agentType: 'claude-code', projectName: 'Beta', weight: 1 },
      { id: 'a', agentType: 'claude-code', projectName: 'Alpha', weight: 1 },
      { id: 'oc', agentType: 'openclaw', projectName: 'Zed', weight: 1 },
    ];
    // openclaw first (rank 0) within the weight band, then Alpha before Beta
    expect(sortSessions(sessions).map(s => s.id)).toEqual(['oc', 'a', 'b']);
  });

  it('maps terminal tab order onto the deck: tab N (weight N) lands in slot N', () => {
    // Five tabs on the same project, launched in arbitrary order, each pinned
    // with --weight matching its terminal tab number.
    const sessions = [
      { id: 'tab3', agentType: 'claude-code', projectName: 'AgentDeck', weight: 3, startedAt: '2026-07-08T10:02:00Z' },
      { id: 'tab1', agentType: 'claude-code', projectName: 'AgentDeck', weight: 1, startedAt: '2026-07-08T10:00:00Z' },
      { id: 'tab5', agentType: 'claude-code', projectName: 'AgentDeck', weight: 5, startedAt: '2026-07-08T10:04:00Z' },
      { id: 'tab2', agentType: 'claude-code', projectName: 'AgentDeck', weight: 2, startedAt: '2026-07-08T10:01:00Z' },
      { id: 'tab4', agentType: 'claude-code', projectName: 'AgentDeck', weight: 4, startedAt: '2026-07-08T10:03:00Z' },
    ];
    expect(sortSessions(sessions).map(s => s.id)).toEqual(['tab1', 'tab2', 'tab3', 'tab4', 'tab5']);
  });

  it('does not change ordering when no session has a weight (backward compatible)', () => {
    const raw = [
      { id: 'session-10', agentType: 'claude-code', projectName: 'AgentDeck', startedAt: '2026-05-11T10:00:00Z' },
      { id: 'session-2', agentType: 'claude-code', projectName: 'AgentDeck', startedAt: '2026-05-11T10:00:00Z' },
      { id: 'oc', agentType: 'openclaw', projectName: 'AgentDeck', startedAt: '2026-05-11T09:00:00Z' },
    ];
    const withZero = raw.map(s => ({ ...s, weight: 0 }));
    expect(sortSessions(raw).map(s => s.id)).toEqual(sortSessions(withZero).map(s => s.id));
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

  it('never folds same-project Codex sessions pinned to distinct weights', () => {
    // Folding runs BEFORE sortSessions on every surface — a weight-blind fold
    // key would silently discard one of two pinned tabs.
    const sessions: FoldableSession[] = [
      { id: 'codex-tab-2', projectName: 'AgentDeck', agentType: 'codex-cli', state: 'processing', weight: 2 },
      { id: 'codex-tab-1', projectName: 'AgentDeck', agentType: 'codex-cli', state: 'idle', weight: 1 },
    ];
    const display = sortSessions(foldCodexSessionsForDisplay(sessions));
    expect(display.map(s => s.id)).toEqual(['codex-tab-1', 'codex-tab-2']);
  });

  it('keeps distinct-weight sessions unfolded across state changes', () => {
    const base: FoldableSession[] = [
      { id: 'codex-tab-1', projectName: 'AgentDeck', agentType: 'codex-cli', state: 'idle', weight: 1 },
      { id: 'codex-tab-2', projectName: 'AgentDeck', agentType: 'codex-cli', state: 'idle', weight: 2 },
    ];
    for (const state of ['processing', 'awaiting_option', 'idle', 'disconnected']) {
      const flipped = base.map(s => (s.id === 'codex-tab-2' ? { ...s, state } : s));
      const display = sortSessions(foldCodexSessionsForDisplay(flipped));
      expect(display.map(s => s.id)).toEqual(['codex-tab-1', 'codex-tab-2']);
    }
  });

  it('still folds same-project Codex sessions when both are unweighted or share a weight', () => {
    const unweighted: FoldableSession[] = [
      { id: 'codex:a', projectName: 'AgentDeck', agentType: 'codex-cli', state: 'idle' },
      { id: 'codex:b', projectName: 'AgentDeck', agentType: 'codex-cli', state: 'idle', weight: 0 },
    ];
    expect(foldCodexSessionsForDisplay(unweighted)).toHaveLength(1);

    const sameWeight: FoldableSession[] = [
      { id: 'codex:c', projectName: 'AgentDeck', agentType: 'codex-cli', state: 'idle', weight: 3 },
      { id: 'codex:d', projectName: 'AgentDeck', agentType: 'codex-cli', state: 'idle', weight: 3 },
    ];
    const folded = foldCodexSessionsForDisplay(sameWeight);
    expect(folded).toHaveLength(1);
    expect(folded[0].groupSize).toBe(2);
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

// ===== Project-prefix grouping (IPS10 office huddle port) =====

import {
  normalizeProjectForGrouping,
  projectGroupKey,
  groupSessionsByProject,
} from '../session-utils.js';

describe('normalizeProjectForGrouping', () => {
  it('strips path and trailing #N suffix', () => {
    expect(normalizeProjectForGrouping('/Users/x/github/AgentDeck')).toBe('AgentDeck');
    expect(normalizeProjectForGrouping('AgentDeck #2')).toBe('AgentDeck');
    expect(normalizeProjectForGrouping('foo-bar-')).toBe('foo-bar');
  });

  it('handles empty/undefined', () => {
    expect(normalizeProjectForGrouping(undefined)).toBe('');
    expect(normalizeProjectForGrouping('  ')).toBe('');
  });
});

describe('projectGroupKey', () => {
  it('exact match groups', () => {
    expect(projectGroupKey('AgentDeck', 'agentdeck')).toBe('AgentDeck');
  });

  it('long multi-token stems fuse', () => {
    expect(
      projectGroupKey('xteink-x3-x4-japanese-broken-claude-glm', 'xteink-x3-x4-japanese-broken-codex'),
    ).toBe('xteink-x3-x4-japanese-broken');
  });

  it('delimiter extension fuses ("foo…" + "foo…-1")', () => {
    expect(
      projectGroupKey('claude-agents-md-check', 'claude-agents-md-check-2'),
    ).toBe('claude-agents-md-check');
  });

  it('short sibling projects stay separate', () => {
    expect(projectGroupKey('agentdeck-ios', 'agentdeck-android')).toBeNull();
    expect(projectGroupKey('AgentDeck', 'BabelForge')).toBeNull();
  });

  it('stems with fewer than 2 delimiters stay separate', () => {
    expect(projectGroupKey('verylongprojectname-a', 'verylongprojectname-b')).toBeNull();
  });
});

describe('groupSessionsByProject', () => {
  const p = (name: string) => ({ projectName: name });

  it('clusters same-stem worktrees and keeps singletons flat', () => {
    const items = [
      p('AgentDeck'),
      p('xteink-x3-x4-japanese-broken-claude-glm'),
      p('BabelForge'),
      p('xteink-x3-x4-japanese-broken-codex'),
      p('xteink-x3-x4-japanese-broken-opencode'),
    ];
    const groups = groupSessionsByProject(items, (i) => i.projectName);
    expect(groups.map((g) => g.key)).toEqual([
      'AgentDeck',
      'xteink-x3-x4-japanese-broken',
      'BabelForge',
    ]);
    expect(groups[1].grouped).toBe(true);
    expect(groups[1].members).toHaveLength(3);
    expect(groups[0].grouped).toBe(false);
  });

  it('groups duplicate sessions of the same project (#N suffixed)', () => {
    const items = [p('AgentDeck #1'), p('BabelForge'), p('AgentDeck #2')];
    const groups = groupSessionsByProject(items, (i) => i.projectName);
    expect(groups.map((g) => g.key)).toEqual(['AgentDeck', 'BabelForge']);
    expect(groups[0].members).toHaveLength(2);
  });

  it('preserves input order within groups', () => {
    const items = [p('proj-x-long-task-name-a'), p('proj-x-long-task-name-b')];
    const groups = groupSessionsByProject(items, (i) => i.projectName);
    expect(groups).toHaveLength(1);
    expect(groups[0].members.map((m) => m.projectName)).toEqual([
      'proj-x-long-task-name-a',
      'proj-x-long-task-name-b',
    ]);
  });
});

describe('rawSessionId / sameSession', () => {
  it('strips every observed agent prefix', () => {
    for (const agent of ['claude', 'codex', 'codex-app', 'opencode', 'antigravity']) {
      expect(rawSessionId(`observed:${agent}:u-9`)).toBe('u-9');
    }
  });

  it('leaves managed and already-bare ids alone', () => {
    expect(rawSessionId('u-9')).toBe('u-9');
    expect(rawSessionId('openclaw-gateway')).toBe('openclaw-gateway');
    // Only a leading prefix is stripped — not an occurrence mid-string.
    expect(rawSessionId('x-observed:claude:u-9')).toBe('x-observed:claude:u-9');
  });

  it('sameSession bridges the two keying forms', () => {
    expect(sameSession('observed:claude:u-9', 'u-9')).toBe(true);
    expect(sameSession('u-9', 'observed:opencode:u-9')).toBe(true);
    expect(sameSession('observed:claude:u-9', 'observed:codex:u-9')).toBe(true);
    expect(sameSession('u-9', 'u-8')).toBe(false);
    expect(sameSession(undefined, 'u-9')).toBe(false);
    expect(sameSession('u-9', '')).toBe(false);
  });
});
