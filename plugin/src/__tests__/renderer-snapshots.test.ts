/**
 * Snapshot tests for all plugin SVG renderers.
 * Each renderer is a pure function (data → SVG string) — ideal for snapshot regression detection.
 * Run `pnpm test -- --update` to regenerate snapshots after intentional visual changes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock label-summarizer before imports (same pattern as text-utils-and-labels.test.ts)
vi.mock('../label-summarizer.js', () => ({
  getCachedLabel: vi.fn(() => null),
  requestAbbreviation: vi.fn(),
}));

import { State, type PromptOption, type SessionInfo } from '@agentdeck/shared';

// ===== utility-renderer =====
import {
  renderUtilityGeneric,
  type UtilityRenderData,
} from '../renderers/utility-renderer.js';

// ===== launcher-renderer =====
import {
  renderLauncher,
  renderLauncherEmpty,
} from '../renderers/launcher-renderer.js';

// ===== usage-dial-renderer =====
import { renderUsageSession } from '../renderers/usage-dial-renderer.js';

// ===== usage-gauge =====
import { renderUsageGauge, renderUsageEncoderBoth, renderUsageEncoderSingle } from '../renderers/usage-gauge.js';




// ===== session-slot-renderer =====
import {
  renderDisconnectedSlot,
  renderSessionSlot,
  renderStatusCard,
} from '../renderers/session-slot-renderer.js';

// ===== display-tile (non-interactive readouts) =====
import {
  renderStatusReadout,
  renderSessionReadout,
} from '../renderers/display-tile.js';



// ===== agent-logos =====
import {
  agentLogoIcon,
  agentLogoWatermark,
  CLAUDE_LOGO_PATH,
} from '../renderers/agent-logos.js';

// ===== Test data factories =====

function makeOption(overrides: Partial<PromptOption> = {}): PromptOption {
  return { index: 0, label: 'Allow', ...overrides };
}

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 'session-1',
    port: 9121,
    projectName: 'AgentDeck',
    agentType: 'claude-code',
    alive: true,
    state: State.IDLE,
    modelName: 'opus-4',
    effortLevel: 'high',
    ...overrides,
  };
}

function makeGroupedEntry(overrides: Partial<{
  ts: number; type: string; raw: string; detail?: string; status?: string;
  count: number; firstTs: number; lastTs: number;
}> = {}) {
  const ts = overrides.ts ?? 1700000000000;
  return {
    entry: {
      ts,
      type: (overrides.type ?? 'tool_request') as any,
      raw: overrides.raw ?? 'Read file.ts',
      detail: overrides.detail,
      status: overrides.status as any,
    },
    count: overrides.count ?? 1,
    firstTs: overrides.firstTs ?? ts,
    lastTs: overrides.lastTs ?? ts,
  };
}

// ===== Determinism =====

let dateNowSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(1700000060000); // 60s after epoch reference
});

afterEach(() => {
  dateNowSpy.mockRestore();
});

// ===================================================================
// Utility Renderer
// ===================================================================

describe('utility-renderer snapshots', () => {
  it('renderUtilityGeneric with icon', () => {
    const data: UtilityRenderData = {
      title: 'VOL',
      icon: '🔊',
      value: '72%',
      indicator: { value: 72, bar_fill_c: '#22c55e' },
    };
    expect(renderUtilityGeneric(data)).toMatchSnapshot();
  });

  it('renderUtilityGeneric muted (text-only value)', () => {
    const data: UtilityRenderData = {
      title: 'VOL',
      value: 'Muted',
      indicator: { value: 0, bar_fill_c: '#64748b' },
    };
    expect(renderUtilityGeneric(data)).toMatchSnapshot();
  });
});

describe('launcher-renderer snapshots', () => {
  it('renderLauncher first entry', () => {
    expect(renderLauncher({
      label: 'Claude',
      detail: 'Open',
      position: 1,
      total: 3,
    })).toMatchSnapshot();
  });

  it('renderLauncher last entry', () => {
    expect(renderLauncher({
      label: 'OpenClaw',
      detail: 'Open',
      position: 3,
      total: 3,
    })).toMatchSnapshot();
  });

  it('renderLauncherEmpty', () => {
    expect(renderLauncherEmpty()).toMatchSnapshot();
  });
});

// ===================================================================
// Usage Dial Renderer
// ===================================================================

describe('usage-dial-renderer snapshots', () => {
  // Use fixed far-future dates so reset time formatting is deterministic
  const sampleData = {
    fiveHourPercent: 45,
    fiveHourResetsAt: '2099-01-01T00:00:00Z',
    sevenDayPercent: 32,
    sevenDayResetsAt: '2099-01-02T00:00:00Z',
    inputTokens: 12500,
    outputTokens: 8300,
    estimatedCostUsd: 0.42,
    sessionDurationSec: 3720,
    extraUsageEnabled: true,
    extraUsageUtilization: 15,
  };




  it('renderUsageSession', () => {
    expect(renderUsageSession(sampleData)).toMatchSnapshot();
  });



});

// ===================================================================
// Usage Gauge (full-bleed level-fill keypad usage tiles)
// ===================================================================

describe('usage-gauge snapshots', () => {
  // Date.now is mocked to 1700000060000 in beforeEach → deterministic countdowns.
  // These resolve to "2h13m" (5h window) and "6d" (7d window).
  const reset5h = '2023-11-15T00:27:20Z';
  const reset7d = '2023-11-20T22:14:20Z';

  it('renderUsageGauge Claude 5h (green ramp, low usage)', () => {
    const svg = renderUsageGauge({ agent: 'claude', window: '5h', label: '5H', usedPercent: 30, resetsAt: reset5h });
    // Claude provider LOGO (brand-tinted) + short label (agent rides the logo, not a prefix).
    expect(svg).toContain('#C07058');
    // The provider logo replaces the old dot — assert the Claude brand path is drawn.
    expect(svg).toContain('M20.998 10.949');
    expect(svg).toContain('>5H<');
    // Headline = USED percent (fill rises with usage).
    expect(svg).toContain('>30<');
    // 30% used ≤ 50 → green severity ramp; fill is a subtle level tint (no chip).
    expect(svg).toContain('#22c55e');
    expect(svg).toContain('fill="#22c55e" opacity="0.38"');
    // No dark overlay chip — legibility from the toned fill + halo'd text.
    expect(svg).not.toContain('opacity="0.72"');
    expect(svg).toMatchSnapshot();
  });

  it('renderUsageGauge Claude 7d', () => {
    expect(renderUsageGauge({ agent: 'claude', window: '7d', label: '7D', usedPercent: 12, resetsAt: reset7d })).toMatchSnapshot();
  });

  it('renderUsageGauge Codex 5h uses the blue brand logo + amber ramp', () => {
    const svg = renderUsageGauge({ agent: 'codex', window: '5h', label: '5H', usedPercent: 55, resetsAt: reset5h });
    expect(svg).toContain('#6166E0');     // Codex brand colour (logo tint)
    expect(svg).toContain('M8.086.457');  // Codex provider logo path
    expect(svg).toContain('>5H<');        // short label — no "CX" prefix
    expect(svg).toContain('>55<');        // used %
    expect(svg).toContain('#eab308');     // 55% used → amber ramp
    expect(svg).toContain('fill="#eab308" opacity="0.38"'); // toned amber level tint
    expect(svg).not.toContain('opacity="0.72"');            // no dark overlay chip
    expect(svg).toMatchSnapshot();
  });

  it('renderUsageGauge Codex 7d', () => {
    expect(renderUsageGauge({ agent: 'codex', window: '7d', label: '7D', usedPercent: 88, resetsAt: reset7d })).toMatchSnapshot();
  });

  it('renderUsageGauge critical (>80 used → red ramp)', () => {
    const svg = renderUsageGauge({ agent: 'claude', window: '5h', label: '5H', usedPercent: 92, resetsAt: reset5h });
    expect(svg).toContain('#ef4444'); // red severity fill
    expect(svg).toContain('>92<');    // used %
    expect(svg).toMatchSnapshot();
  });

  it('renderUsageGauge full-bleed fill (no narrow 60px tank rect)', () => {
    const svg = renderUsageGauge({ agent: 'claude', window: '5h', label: '5H', usedPercent: 50, resetsAt: reset5h });
    // Full-width fill spans the whole 144px tile, not a 60px-wide tank.
    expect(svg).toContain('width="144"');
    expect(svg).not.toContain('width="60"');
  });

  it('renderUsageGauge unknown draws a dim tile + dash, no fill', () => {
    const svg = renderUsageGauge({ agent: 'codex', window: '5h', label: '5H', usedPercent: 0, known: false });
    expect(svg).toContain('>—<');
    // No severity fill on an unknown tile.
    expect(svg).not.toContain('#22c55e');
    expect(svg).not.toContain('#eab308');
    expect(svg).not.toContain('#ef4444');
    expect(svg).toMatchSnapshot();
  });
});

// ===================================================================
// Usage Encoder (SD+ 200×100 level-fill LCD views)
// ===================================================================

describe('usage-encoder level-fill (SD+ 200x100) snapshots', () => {
  const reset5h = '2023-11-15T00:27:20Z';
  const reset7d = '2023-11-20T22:14:20Z';

  const claudeData = {
    agent: 'claude' as const,
    title: 'CLAUDE',
    fiveHour: { label: '5H', usedPercent: 30, resetsAt: reset5h, known: true },
    sevenDay: { label: '7D', usedPercent: 12, resetsAt: reset7d, known: true },
  };
  const codexData = {
    agent: 'codex' as const,
    title: 'CODEX',
    fiveHour: { label: '5H', usedPercent: 55, resetsAt: reset5h, known: true },
    sevenDay: { label: '7D', usedPercent: 88, resetsAt: reset7d, known: true },
  };

  it('both-view Claude shows both windows + terracotta brand logo', () => {
    const svg = renderUsageEncoderBoth(claudeData);
    expect(svg).toContain('width="200" height="100"');
    expect(svg).toContain('#C07058');     // Claude brand colour (logo tint)
    expect(svg).toContain('M20.998 10.949'); // canonical Claude Code robot path
    expect(svg).toContain('>CLAUDE<');    // explicit identity prevents provider confusion
    expect(svg).toContain('>5H<');
    expect(svg).toContain('>7D<');
    expect(svg).toContain('>30<');        // 5h used
    expect(svg).toContain('>12<');        // 7d used
    expect(svg).toContain('opacity="0.38"');     // toned level tint, no chip
    expect(svg).not.toContain('opacity="0.72"');
    expect(svg).toMatchSnapshot();
  });

  it('both-view Codex uses the blue brand logo + severity ramp', () => {
    const svg = renderUsageEncoderBoth(codexData);
    expect(svg).toContain('#6166E0');     // Codex brand colour (logo tint)
    expect(svg).toContain('M8.086.457');  // Codex provider logo path
    expect(svg).toContain('>CODEX<');     // explicit identity prevents provider confusion
    expect(svg).toContain('>55<');        // 5h used (amber)
    expect(svg).toContain('>88<');        // 7d used (red)
    expect(svg).toContain('#eab308');
    expect(svg).toContain('#ef4444');
    expect(svg).toContain('fill="#eab308" opacity="0.38"'); // toned level tint (no chip)
    expect(svg).toMatchSnapshot();
  });

  it('single 5h view enlarges the 5H window across the LCD', () => {
    const svg = renderUsageEncoderSingle(claudeData, '5h');
    expect(svg).toContain('>5H<');
    expect(svg).toContain('>30<');
    expect(svg).not.toContain('>7D<');     // only the 5H window
    expect(svg).toMatchSnapshot();
  });

  it('single 7d view enlarges the 7D window across the LCD', () => {
    const svg = renderUsageEncoderSingle(claudeData, '7d');
    expect(svg).toContain('>7D<');
    expect(svg).toContain('>12<');
    expect(svg).not.toContain('>5H<');
    expect(svg).toMatchSnapshot();
  });

  it('note suppresses the gauges (No Codex usage)', () => {
    const svg = renderUsageEncoderBoth({
      ...codexData,
      fiveHour: { label: '5H', usedPercent: 0, known: false },
      sevenDay: { label: '7D', usedPercent: 0, known: false },
      note: 'No Codex usage',
    });
    expect(svg).toContain('No Codex usage');
    expect(svg).not.toContain('%');        // gauges suppressed in note mode
    expect(svg).toMatchSnapshot();
  });

  it('Waiting note before the first usage payload', () => {
    const svg = renderUsageEncoderSingle({
      ...claudeData,
      fiveHour: { label: '5H', usedPercent: 0, known: false },
      sevenDay: { label: '7D', usedPercent: 0, known: false },
      note: 'Waiting…',
    }, '5h');
    expect(svg).toContain('Waiting…');
    expect(svg).toMatchSnapshot();
  });

  it('a single unknown window draws a dash panel, the other a real fill', () => {
    const svg = renderUsageEncoderBoth({
      agent: 'codex',
      title: 'CODEX',
      fiveHour: { label: '5H', usedPercent: 40, resetsAt: reset5h, known: true },
      sevenDay: { label: '7D', usedPercent: 0, known: false },
    });
    expect(svg).toContain('>40<');         // 5h known
    expect(svg).toContain('>—<');          // 7d unknown
    expect(svg).toMatchSnapshot();
  });
});




// ===================================================================
// Session Slot Renderer
// ===================================================================

describe('session-slot-renderer snapshots', () => {
  it('disconnected hero is icon-rich', () => {
    expect(renderDisconnectedSlot({ kind: 'open-app' })).toMatchSnapshot();
  });

  it('disconnected non-center slot is empty', () => {
    expect(renderDisconnectedSlot({ kind: 'empty' })).toMatchSnapshot();
  });

  it('disconnected cluster quadrant tl', () => {
    expect(renderDisconnectedSlot({ kind: 'open-app', quadrant: 'tl' })).toMatchSnapshot();
  });

  it('disconnected cluster quadrant tr', () => {
    expect(renderDisconnectedSlot({ kind: 'open-app', quadrant: 'tr' })).toMatchSnapshot();
  });

  it('disconnected cluster quadrant bl', () => {
    expect(renderDisconnectedSlot({ kind: 'open-app', quadrant: 'bl' })).toMatchSnapshot();
  });

  it('disconnected cluster quadrant br', () => {
    expect(renderDisconnectedSlot({ kind: 'open-app', quadrant: 'br' })).toMatchSnapshot();
  });

  it('connected no-session card is icon-rich', () => {
    expect(renderStatusCard({ icon: 'no-session', label: 'NO SESSION', subtitle: 'WAITING', tone: 'idle' })).toMatchSnapshot();
  });

  it('active idle session uses orbiting focus border', () => {
    expect(renderSessionSlot(makeSession(), true, 4)).toMatchSnapshot();
  });

  it('stale session dims the render and shows a STALE badge', () => {
    const fresh = renderSessionSlot(makeSession(), false, 4);
    const stale = renderSessionSlot(makeSession(), false, 4, undefined, { isStale: true });
    expect(fresh).not.toContain('STALE');
    expect(stale).toContain('STALE');
    expect(stale).toMatchSnapshot();
  });
});

// ===================================================================
// Display Tiles (non-interactive readouts)
// ===================================================================

describe('display-tile snapshots', () => {
  it('renderStatusReadout MODEL is flat (no raised bezel, no glyph)', () => {
    const svg = renderStatusReadout({ label: 'MODEL', subtitle: 'sonnet 4.6', tone: 'info' });
    // Flat readout: no raised inner key bezel rect, carries the left accent bar.
    expect(svg).not.toContain('128');           // no 128×128 raised bezel rect
    expect(svg).toContain('width="4"');          // left accent strip
    expect(svg).toContain('MODEL');
    expect(svg).toContain('sonnet 4.6');
    expect(svg).toMatchSnapshot();
  });

  it('renderStatusReadout READY (label only)', () => {
    expect(renderStatusReadout({ label: 'READY', subtitle: 'idle', tone: 'ready' })).toMatchSnapshot();
  });

  it('renderStatusReadout AWAITING', () => {
    expect(renderStatusReadout({ label: 'AWAITING', subtitle: 'choose option', tone: 'warning' })).toMatchSnapshot();
  });

  it('renderStatusReadout HUB READY (no-session hub state)', () => {
    expect(renderStatusReadout({ label: 'HUB READY', subtitle: 'CONNECTED', tone: 'ready' })).toMatchSnapshot();
  });

  it('renderSessionReadout keeps name/model/state, flat & non-interactive', () => {
    const svg = renderSessionReadout(makeSession(), State.IDLE, 'opus-4', 'AgentDeck', 'high');
    expect(svg).not.toContain('128');           // no raised bezel
    expect(svg).not.toContain('INFO');           // no button-style INFO badge
    expect(svg).toContain('AgentDeck');
    expect(svg).toContain('IDLE');
    expect(svg).toMatchSnapshot();
  });

  it('renderSessionReadout openclaw hides model, shows STANDBY', () => {
    const svg = renderSessionReadout(
      makeSession({ agentType: 'openclaw', state: State.IDLE, projectName: 'Gateway' }),
      State.IDLE,
      'opus-4',
      undefined,
      'Gateway',
    );
    expect(svg).toContain('STANDBY');
    expect(svg).toMatchSnapshot();
  });
});



// ===================================================================
// Agent Logos
// ===================================================================

describe('agent-logos snapshots', () => {
  it('claude-code watermark', () => {
    expect(agentLogoWatermark('claude-code', '#ffffff', 0.08)).toMatchSnapshot();
  });

  it('openclaw watermark', () => {
    expect(agentLogoWatermark('openclaw', '#ffffff', 0.08)).toMatchSnapshot();
  });

  it('antigravity icon uses the full-color mark', () => {
    const svg = agentLogoIcon('antigravity', 48, 1);
    expect(svg).toContain('antigravity_rainbow');
    expect(svg).toContain('linearGradient');
    expect(svg).toContain('#FF8A18');
    expect(svg).toContain('#247CFF');
  });

  it('CLAUDE_LOGO_PATH is defined', () => {
    expect(CLAUDE_LOGO_PATH).toBeDefined();
    expect(CLAUDE_LOGO_PATH.length).toBeGreaterThan(100);
  });
});
