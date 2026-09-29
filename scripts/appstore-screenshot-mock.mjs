#!/usr/bin/env node

// Deterministic, privacy-safe dashboard feed for App Store screenshots.
// This is a development-only capture helper. It is never bundled in AgentDeck.app.

import { WebSocketServer } from '../bridge/node_modules/ws/wrapper.mjs';
import { readFileSync } from 'node:fs';

const port = Number(process.env.AGENTDECK_SCREENSHOT_PORT || 9220);
const productVersion = readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim();
const wss = new WebSocketServer({ host: '127.0.0.1', port });

const now = Date.now();
const events = [
  {
    type: 'connection',
    status: 'connected',
    sessionId: 'sample-claude',
  },
  {
    type: 'state_update',
    state: 'awaiting_permission',
    permissionMode: 'default',
    sessionId: 'sample-claude',
    focusedSessionId: 'sample-claude',
    agentType: 'claude-code',
    projectName: 'Sample Workspace',
    modelName: 'Claude Sonnet',
    currentTool: 'Edit',
    question: 'Allow the agent to update the dashboard layout?',
    gatewayAvailable: false,
    gatewayConnected: false,
    gatewayHasError: false,
    daemonPort: 9120,
    moduleHealth: {
      streamDeck: { available: true, connected: true, deviceCount: 1 },
      pixoo: { available: true, configuredDeviceCount: 1, connectedDeviceCount: 1 },
      esp32Wifi: {
        available: true,
        devices: [{ board: 'trmnl_75', version: productVersion, stale: false, serialActive: false }],
      },
    },
  },
  {
    type: 'sessions_list',
    sessions: [
      {
        id: 'sample-claude',
        port: 9121,
        projectName: 'Sample Workspace',
        agentType: 'claude-code',
        alive: true,
        state: 'awaiting_permission',
        modelName: 'Claude Sonnet',
        currentTool: 'Edit',
        question: 'Allow the agent to update the dashboard layout?',
        activity: 'Waiting for permission to update the interface',
      },
      {
        id: 'sample-codex',
        port: 9122,
        projectName: 'API Client',
        agentType: 'codex-cli',
        alive: true,
        state: 'processing',
        modelName: 'GPT-5 Codex',
        currentTool: 'Test',
        activity: 'Running the integration test suite',
      },
      {
        id: 'sample-opencode',
        port: 9123,
        projectName: 'Documentation',
        agentType: 'opencode',
        alive: true,
        state: 'idle',
        modelName: 'Qwen Coder',
        activity: 'Ready for the next task',
      },
    ],
  },
  {
    type: 'timeline_history',
    entries: [
      {
        ts: now - 120_000,
        type: 'chat_start',
        raw: 'Improve the dashboard layout for smaller screens',
        agentType: 'claude-code',
        projectName: 'Sample Workspace',
        sessionId: 'sample-claude',
      },
      {
        ts: now - 90_000,
        type: 'chat_response',
        raw: 'Reviewed the layout and prepared a compact responsive update.',
        agentType: 'claude-code',
        projectName: 'Sample Workspace',
        sessionId: 'sample-claude',
      },
      {
        ts: now - 65_000,
        type: 'chat_start',
        raw: 'Run the integration tests',
        agentType: 'codex-cli',
        projectName: 'API Client',
        sessionId: 'sample-codex',
      },
      {
        ts: now - 30_000,
        type: 'chat_response',
        raw: 'All checks passed. The API client is ready.',
        agentType: 'codex-cli',
        projectName: 'API Client',
        sessionId: 'sample-codex',
      },
      {
        ts: now - 10_000,
        type: 'chat_start',
        raw: 'Summarize the release notes',
        agentType: 'opencode',
        projectName: 'Documentation',
        sessionId: 'sample-opencode',
      },
    ],
  },
];

wss.on('connection', (socket, request) => {
  const payloads = structuredClone(events);
  if (request.url === '/dashboard') {
    const state = payloads.find((event) => event.type === 'state_update');
    state.state = 'processing';
    state.currentTool = 'Edit';
    delete state.question;

    const sessions = payloads.find((event) => event.type === 'sessions_list');
    sessions.sessions[0].state = 'processing';
    sessions.sessions[0].activity = 'Refining the responsive dashboard layout';
    delete sessions.sessions[0].question;
  }

  for (const event of payloads) socket.send(JSON.stringify(event));

  socket.on('message', (data) => {
    // Keep the screenshot state deterministic. The client may register or send
    // focus commands; neither changes the synthetic capture feed.
    const text = data.toString();
    if (text.includes('ping')) socket.send(JSON.stringify({ type: 'pong' }));
  });
});

console.log(`AgentDeck App Store screenshot mock: ws://127.0.0.1:${port}`);

const shutdown = () => wss.close(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
