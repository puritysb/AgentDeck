#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderFrame, resetDirector } from '../bridge/dist/pixoo/pixoo-renderer.js';
import { renderSessionSlot } from '../shared/dist/svg-renderers/session-slot-renderer.js';
import { renderUsageWideSlot } from '../shared/dist/d200h-layout.js';
import {
  initTerrarium,
  setOctopi,
  setJellyfish,
  setCrayfish,
  setVoiceAssistantState,
  updateTerrarium,
  renderTerrariumFrame,
} from '../bridge/dist/tui/terrarium.js';
import { renderDashboard } from '../bridge/dist/tui/renderer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(__dirname, '../tools/creature-simulator/index.html');
const outDir = path.resolve('/tmp/agentdeck-creature-simulator');
const outPath = path.join(outDir, 'index.html');

const AGENTS = {
  claude: { type: 'claude-code', name: 'Claude' },
  codex: { type: 'codex-cli', name: 'Codex' },
  opencode: { type: 'opencode', name: 'OpenCode' },
  openclaw: { type: 'openclaw', name: 'OpenClaw' },
  antigravity: { type: 'antigravity', name: 'Antigravity' },
  kiro: { type: 'kiro-cli', name: 'Kiro' },
};
const STATES = ['idle', 'working', 'sleeping', 'asking'];

function withSeed(seed, fn) {
  const originalRandom = Math.random;
  let state = seed >>> 0;
  Math.random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  try {
    return fn();
  } finally {
    Math.random = originalRandom;
  }
}

function simStateToBridge(state) {
  if (state === 'working') return 'processing';
  if (state === 'asking') return 'awaiting_option';
  return 'idle';
}

function buildSessions(selectedAgent, state) {
  const ordered = [
    { key: 'claude', id: 's-claude', alive: true, agentType: 'claude-code', state: selectedAgent === 'claude' ? simStateToBridge(state) : 'idle', projectName: 'Claude', modelName: 'opus-4' },
    { key: 'codex', id: 's-codex', alive: true, agentType: 'codex-cli', state: selectedAgent === 'codex' ? simStateToBridge(state) : 'idle', projectName: 'Codex', modelName: 'gpt-5-codex' },
    { key: 'opencode', id: 's-open', alive: true, agentType: 'opencode', state: selectedAgent === 'opencode' ? simStateToBridge(state) : 'idle', projectName: 'OpenCode', modelName: 'opencode' },
    { key: 'openclaw', id: 's-claw', alive: true, agentType: 'openclaw', state: selectedAgent === 'openclaw' && state === 'working' ? 'processing' : 'idle', projectName: 'OpenClaw', modelName: 'OPENCLAW' },
    { key: 'antigravity', id: 's-antigravity', alive: true, agentType: 'antigravity', state: selectedAgent === 'antigravity' ? simStateToBridge(state) : 'idle', projectName: 'Antigravity', modelName: 'gemini' },
    { key: 'kiro', id: 's-kiro', alive: true, agentType: 'kiro-cli', state: selectedAgent === 'kiro' ? simStateToBridge(state) : 'idle', projectName: 'Kiro', modelName: 'auto' },
  ];
  const selected = ordered.find((session) => session.key === selectedAgent);
  const rest = ordered.filter((session) => session.key !== selectedAgent);
  return selected ? [selected, ...rest].map(({ key, ...session }) => session) : ordered.map(({ key, ...session }) => session);
}

function buildUsage(_animationNow) {
  // Reset labels are formatted against wall-clock time inside the device
  // renderers, so keep simulator deadlines relative to generation time even
  // though animation frames use a fixed timestamp for deterministic poses.
  const now = Date.now();
  return {
    fiveHourPercent: 46,
    sevenDayPercent: 72,
    fiveHourResetsAt: new Date(now + 1000 * 60 * 90).toISOString(),
    sevenDayResetsAt: new Date(now + 1000 * 60 * 60 * 28).toISOString(),
    codexRateLimits: {
      primary: {
        usedPercent: 38,
        windowMinutes: 300,
        resetsAt: new Date(now + 1000 * 60 * 150).toISOString(),
      },
      secondary: {
        usedPercent: 64,
        windowMinutes: 10080,
        resetsAt: new Date(now + 1000 * 60 * 60 * 52).toISOString(),
      },
    },
  };
}

function buildStateEvent(selectedAgent, state) {
  return {
    state: simStateToBridge(state),
    agentType: AGENTS[selectedAgent].type,
    gatewayAvailable: true,
    gatewayHasError: false,
  };
}

function renderPixooData() {
  const now = Date.UTC(2026, 2, 28, 12, 0, 0);
  const result = {};
  for (const agent of Object.keys(AGENTS)) {
    for (const state of STATES) {
      resetDirector();
      const frame = renderFrame(
        buildStateEvent(agent, state),
        buildUsage(now),
        buildSessions(agent, state),
        now + STATES.indexOf(state) * 1000 + Object.keys(AGENTS).indexOf(agent) * 250,
      );
      result[`${agent}:${state}`] = {
        width: 64,
        height: 64,
        b64: Buffer.from(frame).toString('base64'),
      };
    }
  }
  return result;
}

// LED-matrix surfaces render from the SAME canonical renderer as Pixoo64, at the
// device's native size: iDotMatrix 32×32 (standard terrarium) and Timebox Mini
// 11×11 (micro layout). renderFrame supports size 11|32|64.
function renderMatrixData(size, layout) {
  const now = Date.UTC(2026, 2, 28, 12, 0, 0);
  const result = {};
  for (const agent of Object.keys(AGENTS)) {
    for (const state of STATES) {
      resetDirector();
      const frame = renderFrame(
        buildStateEvent(agent, state),
        buildUsage(now),
        buildSessions(agent, state),
        now + STATES.indexOf(state) * 1000 + Object.keys(AGENTS).indexOf(agent) * 250,
        size,
        layout,
      );
      result[`${agent}:${state}`] = {
        width: size,
        height: size,
        b64: Buffer.from(frame).toString('base64'),
      };
    }
  }
  return result;
}

// Canonical D200H merged 5H/7D usage window (288×144) — the real shared renderer
// the plugin-ulanzi deck uses, not a bespoke approximation.
function renderD200HUsageData() {
  const usage = buildUsage(Date.UTC(2026, 2, 28, 12, 0, 0));
  return { svg: renderUsageWideSlot(usage.fiveHourPercent, usage.sevenDayPercent, true) };
}

function renderStreamDeckData() {
  const result = {};
  for (const agent of Object.keys(AGENTS)) {
    for (const state of STATES) {
      const session = buildSessions(agent, state)[0];
      result[`${agent}:${state}`] = {
        svg: renderSessionSlot(session, true, 36, session.projectName),
      };
    }
  }
  return result;
}

function stripAnsi(str) {
  return str.replace(
    /[\u001B\u009B][[\]()#;?]*(?:(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~])/g,
    '',
  );
}

function ansiColorFromCode(code) {
  const palette = {
    30: '#111827',
    31: '#ef4444',
    32: '#22c55e',
    33: '#f59e0b',
    34: '#3b82f6',
    35: '#a855f7',
    36: '#06b6d4',
    37: '#d1d5db',
    90: '#6b7280',
    91: '#f87171',
    92: '#4ade80',
    93: '#fcd34d',
    94: '#60a5fa',
    95: '#c084fc',
    96: '#67e8f9',
    97: '#f9fafb',
  };
  return palette[code] || null;
}

function applySgr(params, currentColor) {
  const parts = params === '' ? [0] : params.split(';').map((part) => Number(part || 0));
  let color = currentColor;
  for (let p = 0; p < parts.length; p++) {
    const code = parts[p];
    if (code === 0 || code === 39) {
      color = null;
    } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
      color = ansiColorFromCode(code);
    } else if (code === 38 && parts[p + 1] === 2) {
      const r = parts[p + 2];
      const g = parts[p + 3];
      const b = parts[p + 4];
      if ([r, g, b].every((v) => Number.isFinite(v))) {
        color = `#${[r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`;
      }
      p += 4;
    }
  }
  return color;
}

function ansiScreenToFrame(text, cols, rows) {
  const screen = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({ ch: ' ', color: null })));
  let row = 0;
  let col = 0;
  let color = null;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    if (ch === '\u001b' && text[i + 1] === '[') {
      let j = i + 2;
      while (j < text.length && !/[A-Za-z]/.test(text[j])) j++;
      const final = text[j];
      const params = text.slice(i + 2, j);
      if (final === 'H' || final === 'f') {
        const [r = '1', c = '1'] = params.split(';');
        row = Math.max(0, Math.min(rows - 1, Number(r) - 1));
        col = Math.max(0, Math.min(cols - 1, Number(c) - 1));
      } else if (final === 'K' && params === '2') {
        screen[row] = Array.from({ length: cols }, () => ({ ch: ' ', color: null }));
        col = 0;
      } else if (final === 'm') {
        color = applySgr(params, color);
      }
      i = j + 1;
      continue;
    }
    if (ch === '\n') {
      row = Math.min(rows - 1, row + 1);
      col = 0;
      i++;
      continue;
    }
    if (row >= 0 && row < rows && col >= 0 && col < cols) {
      screen[row][col] = { ch, color };
    }
    col++;
    i++;
  }

  const lines = [];
  const spans = [];
  for (const line of screen) {
    const last = line.findLastIndex((cell) => cell.ch !== ' ');
    if (last < 0) {
      lines.push('');
      spans.push([]);
      continue;
    }
    lines.push(line.slice(0, last + 1).map((cell) => cell.ch).join(''));

    const rowSpans = [];
    let start = 0;
    let textRun = '';
    let runColor = line[0].color;
    for (let x = 0; x <= last; x++) {
      const cell = line[x];
      if (cell.color !== runColor) {
        if (textRun.trim()) rowSpans.push({ x: start, text: textRun, color: runColor });
        start = x;
        textRun = cell.ch;
        runColor = cell.color;
      } else {
        textRun += cell.ch;
      }
    }
    if (textRun.trim()) rowSpans.push({ x: start, text: textRun, color: runColor });
    spans.push(rowSpans);
  }

  return { lines, spans };
}

function renderTuiData() {
  return withSeed(12345, () => {
    const result = {};
    for (const agent of Object.keys(AGENTS)) {
      for (const state of STATES) {
        const ctx = initTerrarium();
        const sessions = [
          { id: 's-claude', state: agent === 'claude' ? simStateToBridge(state) : 'idle', name: 'Claude', agentType: 'claude-code' },
          { id: 's-codex', state: agent === 'codex' ? simStateToBridge(state) : 'idle', name: 'Codex', agentType: 'codex-cli' },
          { id: 's-open', state: agent === 'opencode' ? simStateToBridge(state) : 'idle', name: 'OpenCode', agentType: 'opencode' },
          { id: 's-claw', state: agent === 'openclaw' && state === 'working' ? 'processing' : 'idle', name: 'OpenClaw', agentType: 'openclaw' },
          { id: 's-antigravity', state: agent === 'antigravity' ? simStateToBridge(state) : 'idle', name: 'Antigravity', agentType: 'antigravity' },
          { id: 's-kiro', state: agent === 'kiro' ? simStateToBridge(state) : 'idle', name: 'Kiro', agentType: 'kiro-cli' },
        ];
        setOctopi(ctx, sessions);
        setJellyfish(ctx, sessions);
        setCrayfish(ctx, true, agent === 'openclaw' && state === 'working', 'OpenClaw', false);
        setVoiceAssistantState(ctx, 'disabled');
        for (let frame = 0; frame < 36; frame++) updateTerrarium(ctx, frame);
        const cols = 160;
        const rows = 40;
        const terrariumLines = renderTerrariumFrame(ctx, cols - Math.max(20, Math.floor(cols * 0.22)) - 3, Math.max(3, Math.floor((rows - 3) * 0.42)), 36);
        const dashboardState = {
          state: simStateToBridge(state),
          connectionStatus: 'connected',
          isStale: false,
          projectName: AGENTS[agent].name,
          modelName: agent === 'claude' ? 'opus-4' : agent === 'codex' ? 'gpt-5-codex' : agent === 'opencode' ? 'opencode' : agent === 'antigravity' ? 'gemini' : agent === 'kiro' ? 'auto' : 'OPENCLAW',
          currentTool: state === 'working' ? 'Read file' : null,
          sessions: buildSessions(agent, state),
          usage: {
            fiveHourPercent: 46,
            sevenDayPercent: 72,
            fiveHourResetsAt: '1h24m',
            sevenDayResetsAt: '1d12h',
            inputTokens: 123400,
            outputTokens: 56700,
            estimatedCostUsd: 12.34,
          },
          modelCatalog: [],
          timeline: [],
          helpVisible: false,
          currentPort: 9120,
          agentType: 'daemon',
          gatewayAvailable: true,
          crayfishRouting: agent === 'openclaw' && state === 'working',
          gatewayHasError: false,
          voiceAssistantState: 'disabled',
          voiceAssistantText: null,
          voiceAssistantResponseText: null,
        };
        const ansi = renderDashboard(dashboardState, cols, rows, terrariumLines, 36, 0);
        const frame = ansiScreenToFrame(ansi, cols, rows);
        result[`${agent}:${state}`] = { width: cols, height: rows, ...frame };
      }
    }
    return result;
  });
}

function renderTuiTerrariumData() {
  return withSeed(12345, () => {
    const result = {};
    for (const agent of Object.keys(AGENTS)) {
      for (const state of STATES) {
        const ctx = initTerrarium();
        const sessions = [
          { id: 's-claude', state: agent === 'claude' ? simStateToBridge(state) : 'idle', name: 'Claude', agentType: 'claude-code' },
          { id: 's-codex', state: agent === 'codex' ? simStateToBridge(state) : 'idle', name: 'Codex', agentType: 'codex-cli' },
          { id: 's-open', state: agent === 'opencode' ? simStateToBridge(state) : 'idle', name: 'OpenCode', agentType: 'opencode' },
          { id: 's-claw', state: agent === 'openclaw' && state === 'working' ? 'processing' : 'idle', name: 'OpenClaw', agentType: 'openclaw' },
          { id: 's-antigravity', state: agent === 'antigravity' ? simStateToBridge(state) : 'idle', name: 'Antigravity', agentType: 'antigravity' },
          { id: 's-kiro', state: agent === 'kiro' ? simStateToBridge(state) : 'idle', name: 'Kiro', agentType: 'kiro-cli' },
        ];
        setOctopi(ctx, sessions);
        setJellyfish(ctx, sessions);
        setCrayfish(ctx, true, agent === 'openclaw' && state === 'working', 'OpenClaw', false);
        setVoiceAssistantState(ctx, 'disabled');
        for (let frame = 0; frame < 36; frame++) updateTerrarium(ctx, frame);
        const width = 84;
        const height = 18;
        const terrariumLines = renderTerrariumFrame(ctx, width, height, 36).map((line) => stripAnsi(line));
        result[`${agent}:${state}`] = { width, height, lines: terrariumLines };
      }
    }
    return result;
  });
}

const simulatorData = {
  pixoo: renderPixooData(),
  idot: renderMatrixData(32, 'standard'),
  timebox: renderMatrixData(11, 'micro'),
  d200hUsage: renderD200HUsageData(),
  streamDeck: renderStreamDeckData(),
  tui: renderTuiData(),
  tuiTerrarium: renderTuiTerrariumData(),
};

const dataPath = path.resolve(__dirname, '../tools/creature-simulator/sim-data.js');
fs.writeFileSync(dataPath, `window.__SIM_DATA = ${JSON.stringify(simulatorData)};`);
console.log(`Simulator data generated at ${dataPath}`);
