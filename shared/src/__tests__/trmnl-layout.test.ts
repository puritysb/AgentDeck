import { describe, it, expect } from 'vitest';
import { renderTrmnlDashboard, TRMNL_WIDTH, TRMNL_HEIGHT } from '../trmnl-layout.js';

const NOW = new Date(2026, 5, 20, 14, 3, 0); // deterministic "14:03" stamp

const session = (id: string, agentType: string, state: string) => ({
  id,
  agentType,
  projectName: `proj-${id}`,
  modelName: 'claude-opus-4-8',
  state,
  alive: true,
  port: 9121,
});

describe('renderTrmnlDashboard', () => {
  it('produces a well-formed 800×480 SVG', () => {
    const svg = renderTrmnlDashboard({ state: 'IDLE', allSessions: [] }, { now: NOW });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain(`width="${TRMNL_WIDTH}"`);
    expect(svg).toContain(`height="${TRMNL_HEIGHT}"`);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
    // A paper background rect must exist so the 1-bit threshold reads clean.
    expect(svg).toContain('fill="#ffffff"');
    expect(svg).toContain('AgentDeck');
  });

  it('renders one row per session with project, description + status badge', () => {
    const svg = renderTrmnlDashboard(
      {
        state: 'PROCESSING',
        allSessions: [
          { ...session('a', 'claude-code', 'processing'), currentTool: 'Edit' },
          session('b', 'codex-cli', 'awaiting_input'),
          session('c', 'opencode', 'idle'),
        ],
      },
      { now: NOW },
    );
    // Project names + a per-session description (tool · model) replace the old
    // wide "CLAUDE" text tag (now a compact agent glyph).
    expect(svg).toContain('proj-a');
    expect(svg).toContain('Edit');
    expect(svg).toContain('opus-4-8'); // model shortened from claude-opus-4-8
    expect(svg).toContain('WORKING');
    expect(svg).toContain('AWAITING');
  });

  it('is monochrome — uses no color tokens beyond black/white', () => {
    const svg = renderTrmnlDashboard(
      { state: 'AWAITING_INPUT', allSessions: [session('a', 'claude-code', 'awaiting_input')] },
      { now: NOW },
    );
    // Every fill/stroke must be pure black or white (no #ef4444 etc.).
    const colors = [...svg.matchAll(/(?:fill|stroke)="(#[0-9a-fA-F]{3,6})"/g)].map((m) => m[1].toLowerCase());
    for (const c of colors) {
      expect(['#000', '#000000', '#fff', '#ffffff']).toContain(c);
    }
  });

  it('renders the idle hero (no synthetic row) when there are no sessions', () => {
    const svg = renderTrmnlDashboard(
      { state: 'IDLE', projectName: 'solo', modelName: 'gpt-5', agentType: 'codex-cli', allSessions: [] },
      { now: NOW },
    );
    expect(svg).toContain('No active sessions');
    expect(svg).toContain('0 sessions · 0 working · 0 awaiting');
    // No phantom session row synthesized from the top-level state.
    expect(svg).not.toContain('CODEX');
    expect(svg).not.toContain('solo');
  });

  it('shows an overflow summary when sessions exceed the visible rows', () => {
    const many = Array.from({ length: 8 }, (_, i) => session(`s${i}`, 'claude-code', 'idle'));
    const svg = renderTrmnlDashboard({ state: 'IDLE', allSessions: many }, { now: NOW });
    expect(svg).toMatch(/\d+ more/);
    expect(svg).toContain('idle'); // overflow breaks down hidden sessions by state
  });

  it('reflows to a device-reported resolution', () => {
    const portrait = renderTrmnlDashboard(
      { state: 'IDLE', allSessions: [] },
      { now: NOW, width: 480, height: 800 },
    );
    expect(portrait).toContain('width="480"');
    expect(portrait).toContain('height="800"');
    expect(portrait).toContain('viewBox="0 0 480 800"');
  });

  it('fits more session rows on a taller panel', () => {
    const many = Array.from({ length: 8 }, (_, i) => session(`s${i}`, 'claude-code', 'idle'));
    const tall = renderTrmnlDashboard({ state: 'IDLE', allSessions: many }, { now: NOW, width: 480, height: 960 });
    const og = renderTrmnlDashboard({ state: 'IDLE', allSessions: many }, { now: NOW });
    // 480×960 fits all 8 rows (no overflow row); 800×480 only fits ~6.
    expect(tall).not.toMatch(/\d+ more/);
    expect(og).toMatch(/\d+ more/);
  });

  it('shows a real percentage when usage is known', () => {
    const svg = renderTrmnlDashboard(
      { state: 'IDLE', allSessions: [], usageKnown: true, fiveHourPercent: 42, sevenDayPercent: 18 },
      { now: NOW },
    );
    expect(svg).toContain('42%');
    expect(svg).toContain('18%');
  });

  it('shows a compact time-until-reset for each quota window (no token tally or clock)', () => {
    const svg = renderTrmnlDashboard(
      {
        state: 'IDLE',
        allSessions: [],
        usageKnown: true,
        fiveHourPercent: 42,
        sevenDayPercent: 18,
        fiveHourResetsAt: new Date(NOW.getTime() + (2 * 3600 + 13 * 60) * 1000).toISOString(),
        sevenDayResetsAt: new Date(NOW.getTime() + (4 * 86400 + 6 * 3600) * 1000).toISOString(),
      },
      { now: NOW },
    );
    // One-line footer uses a compact countdown (2h / 4d), not a full phrase.
    expect(svg).toContain('2h');
    expect(svg).toContain('4d');
    // The old footer noise is gone.
    expect(svg).not.toContain('tok');
    expect(svg).not.toContain('14:03');
  });

  it('shows subscription plans with expiry in the header', () => {
    const svg = renderTrmnlDashboard(
      {
        state: 'IDLE',
        allSessions: [],
        subscriptions: [{ name: 'Claude' }, { name: 'ChatGPT Plus', until: '2026-06-30T00:00:00Z' }],
      },
      { now: NOW },
    );
    expect(svg).toContain('Claude');
    expect(svg).toContain('ChatGPT Plus');
    expect(svg).toContain('Jun 30');
  });

  it('shows an em dash (not 0%) when usage is structurally unknown', () => {
    const svg = renderTrmnlDashboard(
      { state: 'IDLE', allSessions: [], usageKnown: false },
      { now: NOW },
    );
    // Must never claim a confident 0% when the hub has no quota data.
    expect(svg).toContain('—');
    expect(svg).not.toContain('0%');
  });

  it('renders a prominent AWAITING banner when an agent needs the user', () => {
    const svg = renderTrmnlDashboard(
      {
        state: 'AWAITING_PERMISSION',
        allSessions: [
          session('a', 'claude-code', 'awaiting_permission'),
          session('b', 'codex-cli', 'processing'),
        ],
      },
      { now: NOW },
    );
    expect(svg).toContain('1 agent needs you');
    // The banner names the waiting project.
    expect(svg).toContain('proj-a');
  });

  it('collapses to a compact wordmark on a tiny panel without throwing', () => {
    const svg = renderTrmnlDashboard(
      { state: 'IDLE', allSessions: [session('a', 'claude-code', 'processing')] },
      { now: NOW, width: 200, height: 120 },
    );
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('width="200"');
    expect(svg).toContain('height="120"');
    expect(svg).toContain('AgentDeck');
  });
});
