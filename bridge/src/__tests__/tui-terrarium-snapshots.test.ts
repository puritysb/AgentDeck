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
let canonicalTerminalSprite: TerrariumModule['canonicalTerminalSprite'];

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
  canonicalTerminalSprite = terrarium.canonicalTerminalSprite;
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

    expect(plain).toContain('▀');
    expect(plain).toContain('▄');
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


describe('canonical colored terminal creatures', () => {
  it('retains all existing terminal footprints at each scale', () => {
    const expected = {
      claudeCode: [[7, 2], [14, 3], [21, 4]], codex: [[5, 2], [10, 4], [15, 6]],
      openClaw: [[8, 2], [16, 4], [24, 6]], openCode: [[5, 3], [5, 5], [6, 7]],
    };
    for (const [glyph, sizes] of Object.entries(expected)) for (const [i, scale] of ['small', 'large', 'xlarge'].entries()) {
      const sprite = canonicalTerminalSprite(glyph, scale as 'small' | 'large' | 'xlarge', '\x1b[38;2;99;102;241m');
      expect(sprite.braille).toHaveLength(sizes[i][1]);
      expect(sprite.braille.every(row => row.length === sizes[i][0])).toBe(true);
      expect(sprite.cells.flat().some(c => c.top || c.bottom)).toBe(true);
    }
    expect(canonicalTerminalSprite('future-agent', 'small', '').braille).toEqual([]);
    expect(canonicalTerminalSprite('__proto__', 'small', '').braille).toEqual([]);
  });

  it('keeps the OpenCode centre transparent instead of erasing water behind it', () => {
    const ring = canonicalTerminalSprite('openCode', 'xlarge', '\x1b[38;2;241;236;236m');
    expect(ring.cells[3][2]).toEqual({ char: ' ', top: null, bottom: null });
    expect(ring.cells[3][3]).toEqual({ char: ' ', top: null, bottom: null });
  });

  it('fills the original Codex marking and does not blink its geometry away', () => {
    const sprite = canonicalTerminalSprite('codex', 'xlarge', '\x1b[38;2;99;102;241m');
    const samples = sprite.cells.flat().flatMap(c => [c.top, c.bottom]).filter(p => p !== null);
    expect(samples.some(p => p.alpha > .8 && p.rgb[0] > 180 && p.rgb[1] > 180)).toBe(true);
    const ctx = initTerrarium(); ctx.bubbles = []; ctx.schools = [];
    setJellyfish(ctx, [{ id: 'canonical', state: 'idle', agentType: 'codex-cli' }]);
    ctx.jellyfish[0].phaseOffset = 0; ctx.jellyfish[0].x = .5; ctx.jellyfish[0].y = .5;
    expect(renderTerrariumFrame(ctx, 120, 25, 0).slice(1)).toEqual(renderTerrariumFrame(ctx, 120, 25, 6).slice(1));
  });

  it('renders bounded lines after multi-color cells and restores each water-row background', () => {
    const ctx = initTerrarium(); ctx.bubbles = []; ctx.schools = [];
    setOctopi(ctx, [{ id: 'canonical', state: 'idle', agentType: 'claude-code' }]);
    setCrayfish(ctx, true, false, undefined, false);
    for (const [width, height] of [[60, 15], [120, 25], [180, 40]]) {
      const lines = renderTerrariumFrame(ctx, width, height, 0);
      expect(lines).toHaveLength(height);
      for (const line of lines) expect(line.replace(/\x1b\[[0-9;]*m/g, '').length).toBe(width);
      expect(lines.some(line => /[▀▄]/.test(line))).toBe(true);
    }
  });
});


it('native canonical cell data is generated by the real TUI sampler', async () => {
  const { readFileSync } = await import('node:fs');
  const { emitTuiCells, OUTPUT } = await import('../../../scripts/generate-tui-creatures.mjs');
  expect(readFileSync(OUTPUT, 'utf8')).toBe(emitTuiCells());
});

it.runIf(process.platform === 'darwin')('executes the native TUI samples against Node colors, coverage and footprints', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'tui-native-parity-'));
  try {
    writeFileSync(join(dir, 'main.swift'), `import Foundation
var output = [[[[String: Any]]]]()
for key in ["claudeCode","codex","openClaw","openCode"] { for scale in ["small","large","xlarge"] {
 for body in [[40.0,73,105],[212.0,231,171]] {
  let rows = TuiCanonicalCells.cells[key + "." + scale]!.map { row in row.map { cell -> [String:Any] in
   func value(_ p:TuiCanonicalPixel?) -> Any { p.map { ["alpha":$0.alpha,"rgb":$0.rgb(body:body)] } ?? NSNull() }
   return ["top":value(cell.top),"bottom":value(cell.bottom)]
  } }
  output.append(rows)
 }
} }
let boundaries = [[99,20],[100,19],[100,20],[159,35],[160,34],[160,35],[160,19]]
let scales = boundaries.map { TuiCanonicalCells.scale(width:$0[0],height:$0[1]) }
print(String(data:try! JSONSerialization.data(withJSONObject:["frames":output as Any,"scales":scales as Any]),encoding:.utf8)!)
`);
    execFileSync('xcrun', ['swiftc', 'apple/AgentDeck/Rendering/TuiCanonicalCells.generated.swift', join(dir, 'main.swift'), '-o', join(dir, 'replay')], { timeout: 30_000 });
    const packet = JSON.parse(execFileSync(join(dir, 'replay'), { encoding: 'utf8', timeout: 10_000 }));
    expect(packet.scales).toEqual(['small','small','large','large','large','xlarge','small']);
    const actual = packet.frames;
    let i = 0;
    for (const glyph of ['claudeCode','codex','openClaw','openCode']) for (const scale of ['small','large','xlarge'] as const) for (const rgb of [[40,73,105],[212,231,171]]) {
      const expected = canonicalTerminalSprite(glyph, scale, `\x1b[38;2;${rgb.join(';')}m`).cells;
      expect(actual[i]).toHaveLength(expected.length);
      for (let y = 0; y < expected.length; y++) for (let x = 0; x < expected[y].length; x++) for (const half of ['top','bottom'] as const) {
        const a = actual[i][y][x][half], e = expected[y][x][half];
        if (!e) expect(a).toBeNull();
        else { expect(a.alpha).toBeCloseTo(e.alpha, 10); for (let c = 0; c < 3; c++) expect(a.rgb[c]).toBeCloseTo(e.rgb[c], 9); }
      }
      i++;
    }
    expect(i).toBe(24);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  // swiftc alone may take 30 s on a cold or busy host; the 10 s default timed out a pre-release run.
}, 60_000);
