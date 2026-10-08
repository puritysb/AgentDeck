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
  setOpenCode,
  setResidents,
  setCrayfish,
  setVoiceAssistantState,
  updateTerrarium,
  renderTerrariumFrame,
} from '../bridge/dist/tui/terrarium.js';
import { renderDashboard, aquariumSize } from '../bridge/dist/tui/renderer.js';
import { ansiScreenToFrame } from './ansi-demo-frame.mjs';

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
  hermes: { type: 'hermes', name: 'Hermes' },
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
    { key: 'hermes', id: 's-hermes', alive: true, agentType: 'hermes', state: selectedAgent === 'hermes' ? simStateToBridge(state) : 'idle', projectName: 'Hermes (cli)', modelName: 'glm-5.3' },
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
          { id: 's-hermes', state: agent === 'hermes' ? simStateToBridge(state) : 'idle', name: 'Hermes', agentType: 'hermes' },
        ];
        setOctopi(ctx, sessions);
        setJellyfish(ctx, sessions);
        setOpenCode(ctx, sessions);
        setResidents(ctx, sessions);
        setCrayfish(ctx, true, agent === 'openclaw' && state === 'working', 'OpenClaw', false);
        setVoiceAssistantState(ctx, 'disabled');
        for (let frame = 0; frame < 36; frame++) updateTerrarium(ctx, frame);
        const cols = 160;
        const rows = 40;
        const aq = aquariumSize(cols, rows);
        const terrariumLines = aq ? renderTerrariumFrame(ctx, aq.width, aq.height, 36) : [];
        const dashboardState = {
          state: simStateToBridge(state),
          connectionStatus: 'connected',
          isStale: false,
          projectName: AGENTS[agent].name,
          modelName: agent === 'claude' ? 'opus-4' : agent === 'codex' ? 'gpt-5-codex' : agent === 'opencode' ? 'opencode' : agent === 'antigravity' ? 'gemini' : agent === 'kiro' ? 'auto' : agent === 'hermes' ? 'glm-5.3' : 'OPENCLAW',
          currentTool: state === 'working' ? 'Read file' : null,
          sessions: buildSessions(agent, state),
          usage: {
            fiveHourPercent: 46,
            sevenDayPercent: 72,
            fiveHourResetsAt: buildUsage().fiveHourResetsAt,
            sevenDayResetsAt: buildUsage().sevenDayResetsAt,
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
          { id: 's-hermes', state: agent === 'hermes' ? simStateToBridge(state) : 'idle', name: 'Hermes', agentType: 'hermes' },
        ];
        setOctopi(ctx, sessions);
        setJellyfish(ctx, sessions);
        setOpenCode(ctx, sessions);
        setResidents(ctx, sessions);
        setCrayfish(ctx, true, agent === 'openclaw' && state === 'working', 'OpenClaw', false);
        setVoiceAssistantState(ctx, 'disabled');
        for (let frame = 0; frame < 36; frame++) updateTerrarium(ctx, frame);
        const width = 84;
        const height = 18;
        const terrariumLines = renderTerrariumFrame(ctx, width, height, 36);
        result[`${agent}:${state}`] = { width, height, ...ansiScreenToFrame(terrariumLines.join('\n'), width, height) };
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
