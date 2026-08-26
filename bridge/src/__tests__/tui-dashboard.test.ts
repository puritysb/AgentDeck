import { describe, expect, it } from 'vitest';
import stripAnsi from 'strip-ansi';
import type { StateUpdateEvent } from '@agentdeck/shared';
import { renderDashboard } from '../tui/renderer.js';
import { applyStateUpdate, type DashboardState } from '../tui/dashboard.js';

function makeState(overrides: Partial<DashboardState> = {}): DashboardState {
  return {
    state: 'idle',
    connectionStatus: 'connected',
    isStale: false,
    projectName: 'AgentDeck',
    modelName: 'opus-4',
    currentTool: null,
    sessions: [],
    usage: null,
    modelCatalog: [],
    moduleHealth: {},
    timeline: [],
    helpVisible: false,
    currentPort: 9120,
    agentType: 'claude-code',
    gatewayAvailable: false,
    crayfishRouting: false,
    gatewayHasError: false,
    voiceAssistantState: 'disabled',
    voiceAssistantText: null,
    voiceAssistantResponseText: null,
    ...overrides,
  };
}

describe('TUI dashboard models', () => {
  it.each([
    ['wide', 140],
    ['standard', 100],
    ['narrow', 70],
  ])('renders Codex Plus 5h and 7d limits in the %s layout', (_layout, cols) => {
    const output = stripAnsi(renderDashboard(
      makeState({
        usage: {
          type: 'usage_update',
          sessionDurationSec: 0,
          inputTokens: 0,
          outputTokens: 0,
          toolCalls: 0,
          codexRateLimits: {
            primary: { usedPercent: 31, windowMinutes: 300 },
            secondary: { usedPercent: 67, windowMinutes: 10080 },
            planType: 'plus',
          },
        },
      }),
      cols,
      34,
      [],
      0,
      0,
    ));

    expect(output).toContain('Codex 5h');
    expect(output).toContain('31%');
    expect(output).toContain('Codex 7d');
    expect(output).toContain('67%');
  });

  it.each([
    ['wide', 140],
    ['standard', 100],
    ['narrow', 70],
  ])('renders a Codex Pro weekly-only primary window without a phantom 5h row in the %s layout', (_layout, cols) => {
    const output = stripAnsi(renderDashboard(
      makeState({
        usage: {
          type: 'usage_update',
          sessionDurationSec: 0,
          inputTokens: 0,
          outputTokens: 0,
          toolCalls: 0,
          codexRateLimits: {
            primary: { usedPercent: 44, windowMinutes: 10080 },
            planType: 'pro',
          },
        },
      }),
      cols,
      34,
      [],
      0,
      0,
    ));

    expect(output).toContain('Codex 7d');
    expect(output).toContain('44%');
    expect(output).not.toContain('Codex 5h');
  });

  it('stores modelCatalog from state_update', () => {
    const state = makeState({
      modelCatalog: [{ name: 'old-model', role: 'configured', available: true }],
    });

    applyStateUpdate(state, {
      type: 'state_update',
      state: 'idle',
      permissionMode: 'default',
      modelCatalog: [
        { name: 'opus-4', role: 'default', available: true },
        { name: 'sonnet-4', role: 'fallback-1', available: true },
      ],
    } as StateUpdateEvent);

    expect(state.modelCatalog.map((m) => m.name)).toEqual(['opus-4', 'sonnet-4']);
  });

  it('renders OAuth catalog and Ollama models in wide layout', () => {
    const output = stripAnsi(renderDashboard(
      makeState({
        usage: {
          type: 'usage_update',
          sessionDurationSec: 90,
          inputTokens: 0,
          outputTokens: 0,
          toolCalls: 0,
          oauthConnected: true,
          ollamaStatus: {
            available: true,
            models: [
              { name: 'qwen2.5:7b', size: 4_500_000_000, sizeVram: 4_500_000_000 },
              { name: 'llama3.2:3b', size: 2_000_000_000, sizeVram: 0 },
            ],
          },
        },
        modelCatalog: [
          { name: 'opus-4', role: 'default', available: true },
          { name: 'sonnet-4', role: 'fallback-1', available: true },
        ],
      }),
      140,
      28,
      [],
      0,
      0,
    ));

    expect(output).toContain('MODELS');
    expect(output).toContain('OAuth: opus-4, sonnet-4');
    expect(output).toContain('Ollama: qwen2.5:7b 4.5G');
    expect(output).toContain('Ollama: llama3.2:3b 2.0G');
  });

  it('renders disconnected OAuth state', () => {
    const output = stripAnsi(renderDashboard(
      makeState({
        usage: {
          type: 'usage_update',
          sessionDurationSec: 30,
          inputTokens: 0,
          outputTokens: 0,
          toolCalls: 0,
          oauthConnected: false,
          ollamaStatus: { available: false, models: [] },
        },
      }),
      100,
      24,
      [],
      0,
      0,
    ));

    expect(output).toContain('OAuth: disconnected');
    expect(output).toContain('Ollama: stopped');
  });

  it('renders downstream module health compactly', () => {
    const output = stripAnsi(renderDashboard(
      makeState({
        moduleHealth: {
          serial: {
            connectionCount: 2,
            connections: [
              { connected: true, deviceInfo: { board: 'ips_35' } },
              { connected: true, deviceInfo: { board: 'ulanzi_tc001' } },
            ],
          },
          pixoo: {
            configuredDeviceCount: 1,
            devices: [{ online: true, backedOff: false }],
          },
          d200h: { connected: true, driver: 'ulanzi-plugin' },
          adb: { available: true, devices: ['CREMA'], reverseReadyCount: 1 },
        },
      }),
      180,
      32,
      [],
      0,
      0,
    ));

    expect(output).toContain('DOWNSTREAM');
    expect(output).toContain('Serial 2: ips_35, ulanzi_tc001');
    expect(output).toContain('Pixoo 1/1');
    expect(output).toContain('D200H ready plugin');
    expect(output).toContain('ADB 1 reverse');
  });

  it('renders Stream Deck, WiFi-only ESP32, and TUI dashboard downstream rows', () => {
    const output = stripAnsi(renderDashboard(
      makeState({
        moduleHealth: {
          streamDeck: {
            available: true,
            devices: [{ name: 'Stream Deck +', columns: 4, rows: 2 }],
          },
          // Dual-homed ulanzi_tc001 (serialActive:true) must be filtered out —
          // it already shows in the Serial row; only the WiFi-only boards get
          // their own "Wi-Fi ESP32" rows (mirrors TopologyRail dedup).
          esp32Wifi: {
            available: true,
            devices: [
              { board: 'ips_35', ip: '192.168.68.69', stale: false, serialActive: false },
              { board: 'ulanzi_tc001', ip: '192.168.68.57', stale: false, serialActive: true },
            ],
          },
          tuiDashboards: {
            available: true,
            devices: [{ id: 'host#1', name: 'sbstudio.local', kind: 'tui' }],
          },
        },
      }),
      200,
      36,
      [],
      0,
      0,
    ));

    expect(output).toContain('Stream Deck + 4×2');
    expect(output).toContain('Wi-Fi ESP32 ips_35');
    expect(output).toContain('192.168.68.69');
    // Dual-homed board is deduped out of the WiFi rows entirely (shown only in
    // the Serial row, which this fixture omits) — so it appears nowhere here.
    expect(output).not.toContain('ulanzi_tc001');
    expect(output).toContain('TUI Dashboard sbstudio.local');
  });

  it('shows current session summary and control hints', () => {
    const output = stripAnsi(renderDashboard(
      makeState({
        projectName: 'my-project',
        modelName: 'sonnet-4',
        state: 'processing',
        sessions: [{ id: 's1', port: 9121, projectName: 'other', alive: true, state: 'idle' }],
      }),
      100,
      24,
      [],
      0,
      0,
    ));

    expect(output).toContain('my-project · sonnet-4 · PROC');
    expect(output).toContain('q quit  ↑↓/j k scroll  1-9 switch session');
  });

  it('renders agent list secondary line as model dash compact state', () => {
    const output = stripAnsi(renderDashboard(
      makeState({
        projectName: 'my-project',
        modelName: 'sonnet-4',
        state: 'processing',
      }),
      120,
      28,
      [],
      0,
      0,
    ));

    expect(output).toContain('sonnet-4 - PROC');
  });

  it('renders sibling models in session bridge mode and omits uptime label', () => {
    const output = stripAnsi(renderDashboard(
      makeState({
        projectName: 'primary',
        modelName: 'opus-4',
        state: 'idle',
        sessions: [
          { id: 's1', port: 9121, projectName: 'other', alive: true, state: 'processing', modelName: 'codex-mini' },
        ],
        usage: {
          type: 'usage_update',
          sessionDurationSec: 90,
          inputTokens: 1200,
          outputTokens: 3400,
          toolCalls: 2,
        },
      }),
      120,
      28,
      [],
      0,
      0,
    ));

    expect(output).toContain('codex-mini - PROC');
    expect(output).not.toContain('Up:');
  });

  it('renders help overlay when helpVisible is on', () => {
    const output = stripAnsi(renderDashboard(
      makeState({
        helpVisible: true,
      }),
      100,
      30,
      [],
      0,
      0,
    ));

    expect(output).toContain('AgentDeck TUI Help');
    expect(output).toContain('? / h    toggle help');
    expect(output).toContain('Press ? or Esc to return');
  });

  it('shows numbered session badges', () => {
    const output = stripAnsi(renderDashboard(
      makeState({
        sessions: [
          { id: 's1', port: 9121, projectName: 'build', alive: true, state: 'processing' },
          { id: 's2', port: 9122, projectName: 'docs', alive: true, state: 'idle' },
        ],
      }),
      140,
      28,
      [],
      0,
      0,
    ));

    expect(output).toContain('[1]');
    expect(output).toContain('[2]');
  });
});
