/**
 * Snapshot tests for TUI terrarium braille rendering.
 * Tests the exported API functions: initTerrarium, setOctopi, setCrayfish,
 * setJellyfish, updateTerrarium, renderTerrariumFrame.
 *
 * Math.random is mocked for deterministic bubble/school initialization.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';

type TerrariumModule = typeof import('../tui/terrarium.js');

let initTerrarium: TerrariumModule['initTerrarium'];
let setOctopi: TerrariumModule['setOctopi'];
let setCrayfish: TerrariumModule['setCrayfish'];
let setJellyfish: TerrariumModule['setJellyfish'];
let setOpenCode: TerrariumModule['setOpenCode'];
let updateTerrarium: TerrariumModule['updateTerrarium'];
let renderTerrariumFrame: TerrariumModule['renderTerrariumFrame'];

let randomIndex = 0;
const RANDOM_SEQ = [
  0.5, 0.3, 0.7, 0.1, 0.9, 0.4, 0.6, 0.2, 0.8, 0.15,
  0.55, 0.35, 0.75, 0.25, 0.65, 0.45, 0.85, 0.95, 0.05, 0.50,
  0.33, 0.66, 0.11, 0.88, 0.44, 0.77, 0.22, 0.99, 0.01, 0.51,
  0.42, 0.58, 0.31, 0.69, 0.18, 0.82, 0.37, 0.63, 0.29, 0.71,
  0.5, 0.3, 0.7, 0.1, 0.9, 0.4, 0.6, 0.2, 0.8, 0.15,
  0.55, 0.35, 0.75, 0.25, 0.65, 0.45, 0.85, 0.95, 0.05, 0.50,
];

let randomSpy: ReturnType<typeof vi.spyOn>;
const originalColorTerm = process.env.COLORTERM;
const originalTerm = process.env.TERM;
const originalLang = process.env.LANG;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeAll(async () => {
  process.env.COLORTERM = 'truecolor';
  process.env.TERM = 'xterm-direct';
  process.env.LANG = process.env.LANG || 'en_US.UTF-8';
  vi.resetModules();

  const terrarium = await import('../tui/terrarium.js');
  initTerrarium = terrarium.initTerrarium;
  setOctopi = terrarium.setOctopi;
  setCrayfish = terrarium.setCrayfish;
  setJellyfish = terrarium.setJellyfish;
  setOpenCode = terrarium.setOpenCode;
  updateTerrarium = terrarium.updateTerrarium;
  renderTerrariumFrame = terrarium.renderTerrariumFrame;
});

beforeEach(() => {
  randomIndex = 0;
  randomSpy = vi.spyOn(Math, 'random').mockImplementation(() => {
    const val = RANDOM_SEQ[randomIndex % RANDOM_SEQ.length];
    randomIndex++;
    return val;
  });
});

afterEach(() => {
  randomSpy.mockRestore();
});

afterAll(() => {
  restoreEnv('COLORTERM', originalColorTerm);
  restoreEnv('TERM', originalTerm);
  restoreEnv('LANG', originalLang);
});

describe('TUI terrarium snapshots', () => {
  it('initTerrarium creates context with expected structure', () => {
    const ctx = initTerrarium();
    expect(ctx.octopi).toHaveLength(0);
    expect(ctx.jellyfish).toHaveLength(0);
    expect(ctx.crayfish.visible).toBe(false);
    expect(ctx.bubbles.length).toBeGreaterThan(0);
    expect(ctx.schools).toHaveLength(2);
  });

  it('setOctopi configures octopus instances', () => {
    const ctx = initTerrarium();
    setOctopi(ctx, [
      { id: 'a', state: 'idle', name: 'TestProject', agentType: 'claude-code' },
      { id: 'b', state: 'processing', name: 'AgentDeck', agentType: 'claude-code' },
    ]);
    expect(ctx.octopi).toHaveLength(2);
    expect(ctx.octopi[0].name).toBe('TestProject');
    expect(ctx.octopi[1].state).toBe('processing');
  });

  it('draws an octopus for Claude and for nobody else', () => {
    // The filter used to be a deny-list — "everything that is not one of these
    // five is a Claude octopus" — so every agent added after it was written
    // swam as Claude. Kiro and Antigravity sessions were drawn with Claude's
    // creature here while the Stream Deck, Pixoo and both apps had them right.
    //
    // This pins the POLARITY, not the membership: adding a real agent needs no
    // edit here, but spelling the filter as an exclusion again fails.
    const ctx = initTerrarium();
    setOctopi(ctx, [
      { id: 'claude', state: 'idle', name: 'Claude', agentType: 'claude-code' },
      { id: 'kiro', state: 'idle', name: 'Kiro', agentType: 'kiro-cli' },
      { id: 'kiro-ide', state: 'idle', name: 'KiroIDE', agentType: 'kiro-ide' },
      { id: 'agy', state: 'idle', name: 'Antigravity', agentType: 'antigravity' },
      { id: 'future', state: 'idle', name: 'NotYetInvented', agentType: 'some-2027-agent' },
      { id: 'none', state: 'idle', name: 'NoType' },
    ]);
    expect(ctx.octopi.map(o => o.name)).toEqual(['Claude']);
  });

  it('setCrayfish configures crayfish state', () => {
    const ctx = initTerrarium();
    setCrayfish(ctx, true, true, 'Gateway', false);
    expect(ctx.crayfish.visible).toBe(true);
    expect(ctx.crayfish.routing).toBe(true);
  });

  it('setJellyfish configures jellyfish instances', () => {
    const ctx = initTerrarium();
    setJellyfish(ctx, [
      { id: 'j1', state: 'idle', name: 'Codex', agentType: 'codex-cli' },
    ]);
    expect(ctx.jellyfish).toHaveLength(1);
    expect(ctx.jellyfish[0].name).toBe('Codex');
  });

  it('renderTerrariumFrame empty terrarium (small)', () => {
    const ctx = initTerrarium();
    updateTerrarium(ctx, 0);
    const lines = renderTerrariumFrame(ctx, 60, 15, 0);
    expect(lines).toHaveLength(15);
    expect(lines).toMatchSnapshot();
  });

  it('renderTerrariumFrame empty terrarium (large)', () => {
    const ctx = initTerrarium();
    updateTerrarium(ctx, 0);
    const lines = renderTerrariumFrame(ctx, 120, 25, 0);
    expect(lines).toHaveLength(25);
    expect(lines).toMatchSnapshot();
  });

  it('renderTerrariumFrame with idle octopus', () => {
    const ctx = initTerrarium();
    setOctopi(ctx, [{ id: 'a', state: 'idle', name: 'Test', agentType: 'claude-code' }]);
    updateTerrarium(ctx, 0);
    const lines = renderTerrariumFrame(ctx, 80, 20, 0);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines).toMatchSnapshot();
  });

  it('renderTerrariumFrame with processing octopus', () => {
    const ctx = initTerrarium();
    setOctopi(ctx, [{ id: 'a', state: 'processing', name: 'AgentDeck', agentType: 'claude-code' }]);
    updateTerrarium(ctx, 10);
    const lines = renderTerrariumFrame(ctx, 80, 20, 10);
    expect(lines).toMatchSnapshot();
  });

  it('renderTerrariumFrame with routing crayfish', () => {
    const ctx = initTerrarium();
    setCrayfish(ctx, true, true, 'OpenClaw');
    updateTerrarium(ctx, 5);
    const lines = renderTerrariumFrame(ctx, 80, 20, 5);
    expect(lines).toMatchSnapshot();
  });

  it('renderTerrariumFrame with sick crayfish', () => {
    const ctx = initTerrarium();
    setCrayfish(ctx, true, false, 'Gateway', true);
    updateTerrarium(ctx, 0);
    const lines = renderTerrariumFrame(ctx, 80, 20, 0);
    expect(lines).toMatchSnapshot();
  });

  it('renderTerrariumFrame with OpenCode hollow ring', () => {
    const ctx = initTerrarium();
    setOpenCode(ctx, [{ id: 'oc1', state: 'idle', name: 'OpenCode', agentType: 'opencode' }]);
    updateTerrarium(ctx, 0);
    const plain = renderTerrariumFrame(ctx, 80, 20, 0)
      .join('\n')
      .replace(/\x1b\[[0-9;]*m/g, '');

    expect(plain).toContain('┌───┐');
    expect(plain).toContain('│   │');
    expect(plain).not.toContain('│┌─┐│');
  });

  it('renderTerrariumFrame too small returns empty', () => {
    const ctx = initTerrarium();
    const lines = renderTerrariumFrame(ctx, 10, 2, 0);
    expect(lines).toHaveLength(0);
  });

  it('updateTerrarium advances bubble positions', () => {
    const ctx = initTerrarium();
    const y0 = ctx.bubbles[0].y;
    updateTerrarium(ctx, 0);
    updateTerrarium(ctx, 1);
    // Bubbles should move up (y decreases)
    expect(ctx.bubbles[0].y).toBeLessThan(y0);
  });
});
