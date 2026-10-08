import { describe, expect, it } from 'vitest';
import type { SessionInfo, TimelineEntry, UsageEvent } from '@agentdeck/shared';
import {
  buildRoster, rosterCounts, rosterDensity, summarizeRoster, buildUsageGroups, buildTimelineRows,
} from '../tui/model.js';
import { renderDashboard, defaultView } from '../tui/renderer.js';
import { textWidth, displayWidth, truncateWidth } from '../tui/width.js';
import { initTerrarium, setResidents, renderTerrariumFrame, updateTerrarium } from '../tui/terrarium.js';
import type { DashboardState } from '../tui/dashboard.js';

const NOW = Date.parse('2026-10-07T00:00:00Z');

function state(overrides: Partial<DashboardState> = {}): DashboardState {
  return {
    state: 'idle', connectionStatus: 'connected', hasConnected: true, isStale: false,
    projectName: null, modelName: null, currentTool: null, sessions: [], usage: null,
    modelCatalog: [], moduleHealth: {}, timeline: [], helpVisible: false, currentPort: 9120,
    agentType: 'daemon', gatewayAvailable: false, crayfishRouting: false, gatewayHasError: false,
    voiceAssistantState: 'disabled', voiceAssistantText: null, voiceAssistantResponseText: null,
    ...overrides,
  };
}

function session(over: Partial<SessionInfo>): SessionInfo {
  return { id: 'x', port: 0, projectName: 'p', alive: true, state: 'idle', agentType: 'claude-code', ...over };
}

function usage(over: Partial<UsageEvent>): UsageEvent {
  return { type: 'usage_update', sessionDurationSec: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, ...over };
}

/** Rows of a cursor-addressed frame, escapes stripped. */
function screenRows(ansi: string): string[] {
  const out: string[] = [];
  const parts = ansi.split(/\x1b\[(\d+);1H/);
  for (let i = 1; i < parts.length; i += 2) out[Number(parts[i]) - 1] = parts[i + 1]!.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  return out;
}

describe('roster cards', () => {
  it('carries the observed session axes (#463) and a CI wait as the focus line', () => {
    const [card] = buildRoster(state({
      sessions: [session({
        id: 'observed:claude:a', state: 'processing', modelName: 'claude-opus-5-5',
        effortLevel: 'high', permissionMode: 'auto', controlMode: 'observed',
        subagents: { active: 3, peak: 3, completed: 1 },
        waitingOn: { kind: 'ci', provider: 'github-actions', phase: 'running', agentWaiting: true, evidence: 'github', openedAt: NOW, pr: 412, checks: { total: 5, passed: 3, failed: 0, pending: 2 } },
        activity: 'Running tests',
      })],
    }));
    expect(card!.meta).toEqual(['claude-opus-5-5', 'high', 'auto', 'observed']);
    expect(card!.focus).toEqual({ kind: 'ci', text: 'CI running #412 · 3/5' });
    expect(card!.subagents).toBe(3);
    expect(card!.hotkey).toBeNull(); // observed sessions are not switchable
    expect(rosterCounts([card!])).toMatchObject({ working: 1, ci: 1 });
  });

  it('does not invent a CI wait the agent is not blocked on', () => {
    const [card] = buildRoster(state({
      sessions: [session({ waitingOn: { kind: 'ci', provider: 'github-actions', phase: 'running', agentWaiting: false, evidence: 'tool_input', openedAt: NOW } })],
    }));
    expect(card!.ci).toBeUndefined();
  });

  it('puts the question first for a session that needs you', () => {
    const [card] = buildRoster(state({
      sessions: [session({ state: 'awaiting_permission', question: 'Run rm -rf build?' })],
    }));
    expect(card!.tone).toBe('awaiting');
    expect(card!.focus).toEqual({ kind: 'question', text: 'Run rm -rf build?' });
  });

  it('treats an over-100% context reading as unknown, not full', () => {
    const cards = buildRoster(state({
      sessions: [session({ id: 'a', contextPercent: 204.2 }), session({ id: 'b', contextPercent: 42.4 })],
    }));
    expect(cards.map(c => c.context)).toEqual([undefined, 42]);
  });

  it('keeps urgent and working rows explicit in a summarized roster and names what it hid', () => {
    const sessions = Array.from({ length: 18 }, (_, i) => session({ id: `s${i}`, projectName: `p${i}`, state: i === 0 ? 'awaiting_option' : i < 3 ? 'processing' : 'idle' }));
    const cards = buildRoster(state({ sessions }));
    expect(rosterDensity(cards.length)).toBe('summarized');
    const sum = summarizeRoster(cards);
    expect(sum.shown.map(c => c.tone).sort()).toEqual(['awaiting', 'working', 'working']);
    expect(sum.hiddenIdle).toBe(15);
    expect(rosterDensity(6)).toBe('detailed');
    expect(rosterDensity(7)).toBe('grouped');
  });
});

describe('usage groups', () => {
  it('orders providers like every other surface and names plan tiers', () => {
    const groups = buildUsageGroups(usage({
      fiveHourPercent: 40, sevenDayPercent: 57, oauthConnected: true,
      codexRateLimits: { secondary: { usedPercent: 97, windowMinutes: 10080, resetsAt: '2026-10-09T22:45:26Z' }, planType: 'pro', capturedAt: '2026-10-06T23:59:00Z' },
      codexSubscriptionActiveUntil: '2026-10-10T12:28:05+00:00',
      zaiRateLimits: { planType: 'max', primary: { usedPercent: 0, windowMinutes: 300 }, secondary: { usedPercent: 1, windowMinutes: 43200, quantity: 'mcp' } },
      subscriptions: [{ name: 'ChatGPT Pro', until: '2026-10-10T12:28:05+00:00' }, { name: 'GLM Coding Plan · Max' }, { name: 'Google AI Pro' }],
      antigravityStatus: { planName: 'Google AI Pro', availableCredits: 1000 },
    }), NOW);
    expect(groups.map(g => g.id)).toEqual(['claude', 'codex', 'zai', 'antigravity']);
    const codex = groups[1]!;
    expect(codex).toMatchObject({ tier: 'Pro', until: 'until Oct 10' });
    expect(codex.rows.map(r => r.label)).toEqual(['7d']);
    expect(groups[2]!.rows.map(r => r.label)).toEqual(['5h', 'MCP']);
    expect(groups[2]!.tier).toBe('Max');
    // A subscription card with no percentage and no credit counter.
    expect(groups[3]).toMatchObject({ tier: 'Pro', rows: [] });
  });

  it('shows credits only once a plan window is exhausted', () => {
    const base = { planType: 'pro', credits: { hasCredits: true, unlimited: false, balance: '59678.7' }, capturedAt: '2026-10-06T23:59:00Z' };
    const live = buildUsageGroups(usage({ codexRateLimits: { ...base, secondary: { usedPercent: 97, windowMinutes: 10080, resetsAt: '2026-10-09T00:00:00Z' } } }), NOW);
    expect(live[0]!.rows.some(r => r.label === 'credits')).toBe(false);
    const spent = buildUsageGroups(usage({ codexRateLimits: { ...base, secondary: { usedPercent: 100, windowMinutes: 10080, resetsAt: '2026-10-09T00:00:00Z' } } }), NOW);
    expect(spent[0]!.rows.find(r => r.label === 'credits')).toMatchObject({ value: '59.6K left' });
  });

  it('dims an aged Codex snapshot and says how old it is', () => {
    const [codex] = buildUsageGroups(usage({ codexRateLimits: { primary: { usedPercent: 20, windowMinutes: 300, resetsAt: '2026-10-07T02:00:00Z' }, capturedAt: '2026-10-06T21:00:00Z' } }), NOW);
    expect(codex!.rows[0]).toMatchObject({ muted: true, note: '3h ago' });
  });

  it('greys stale Claude windows and surfaces a rejected z.ai key', () => {
    const [claude, zai] = buildUsageGroups(usage({
      fiveHourPercent: 95, usageStale: true, oauthConnected: true,
      zaiRateLimits: { authFailed: true },
    }), NOW);
    expect(claude!.rows[0]).toMatchObject({ used: 95, muted: true });
    expect(claude!.alert).toMatchObject({ level: 'quiet' });
    expect(zai!.alert).toEqual({ text: 'API key rejected', level: 'error' });
  });
});

describe('activity follow', () => {
  const rows: TimelineEntry[] = [
    { ts: 1, type: 'chat_start', raw: 'mine', sessionId: '058ab6cd-8230', agentType: 'claude-code' },
    { ts: 2, type: 'chat_start', raw: 'other', sessionId: '711820ad-a53b', agentType: 'claude-code' },
    { ts: 3, type: 'chat_response', raw: 'claw', sessionId: 'openclaw:agent:main:main', agentType: 'openclaw' },
  ];
  it('matches an observed roster id to the bare timeline id', () => {
    expect(buildTimelineRows(rows, { id: 'observed:claude:058ab6cd-8230', agentType: 'claude-code' }).map(r => r.text)).toEqual(['mine']);
  });
  it('follows OpenClaw by agent when its roster key differs from its run key', () => {
    expect(buildTimelineRows(rows, { id: 'openclaw-gateway', agentType: 'openclaw' }).map(r => r.text)).toEqual(['claw']);
  });
});

describe('terminal width', () => {
  it('counts Hangul, CJK and emoji as two cells and marks as zero', () => {
    expect(textWidth('릴리즈')).toBe(6);
    expect(textWidth('á')).toBe(1);
    expect(textWidth('🦞')).toBe(2);
    expect(displayWidth('\x1b[31m한글\x1b[0m')).toBe(4);
    const cut = truncateWidth('\x1b[36m릴리즈한 최종 버전\x1b[0m', 7);
    expect(displayWidth(cut)).toBeLessThanOrEqual(7);
    expect(cut.endsWith('\x1b[0m')).toBe(true);
  });

  it.each([[160, 45], [120, 36], [100, 30], [72, 30]])('keeps every row exactly %i cells with Korean content', (cols, rows) => {
    const st = state({
      sessions: [
        session({ id: 'observed:claude:k', projectName: '한국어 프로젝트', state: 'processing', goal: '릴리즈한 최종 버전이 현재 각 surface 에 잘 배포되어 있는지 점검하라.' }),
        session({ id: 'openclaw-gateway', projectName: 'OpenClaw', agentType: 'openclaw', state: 'idle' }),
      ],
      timeline: [{ ts: NOW, type: 'chat_start', raw: '지난 10/3 ~ 10/5 기간동안 세 가족이 다녀온 여행 사진과 영상', agentType: 'claude-code' }],
      usage: usage({ fiveHourPercent: 41, sevenDayPercent: 57, oauthConnected: true }),
    });
    for (const tab of ['sessions', 'usage', 'activity', 'devices'] as const) {
      for (const detail of [false, true]) {
        const out = screenRows(renderDashboard(st, cols, rows, [], 0, 0, { ...defaultView(), tab, detail }));
        expect(out).toHaveLength(rows);
        for (const line of out) expect(displayWidth(line)).toBe(cols);
      }
    }
  });
});

describe('aquarium residents', () => {
  it('gives Antigravity, Kiro and Hermes their own creature and an unknown agent none', () => {
    const ctx = initTerrarium();
    setResidents(ctx, [
      { id: 'a', state: 'processing', name: 'Agy', agentType: 'antigravity' },
      { id: 'k', state: 'awaiting_permission', name: 'Kiro', agentType: 'kiro-ide' },
      { id: 'h', state: 'idle', name: 'Hermes', agentType: 'hermes' },
      { id: 'c', state: 'idle', name: 'Claude', agentType: 'claude-code' },
      { id: 'f', state: 'idle', name: 'Future', agentType: 'some-2027-agent' },
    ]);
    expect(ctx.residents.map(r => r.glyph)).toEqual(['antigravity', 'kiro', 'hermes']);
    for (let f = 0; f < 60; f++) updateTerrarium(ctx, f);
    const frame = renderTerrariumFrame(ctx, 120, 24, 60).map(l => l.replace(/\x1b\[[0-9;]*m/g, ''));
    // Needs-you is a solid amber "!" badge (DESIGN.md §6.4), never "?".
    expect(frame.some(l => l.includes('!'))).toBe(true);
    expect(frame.some(l => l.includes('?'))).toBe(false);
    expect(frame.some(l => /[▀▄]/.test(l))).toBe(true);
  });
});
