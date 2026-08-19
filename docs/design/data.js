// Shared mock data for AgentDeck menubar popup prototypes.
// Reads colors from window.DT (design/tokens.js) — load tokens.js before this file.

(function () {
  const DT = window.DT;
  if (!DT) {
    console.error('data.js: design/tokens.js must load before data.js');
    return;
  }

  const AGENTS = {
    'claude-code': { label: 'Claude',   color: DT.Brand.claudeCode, creature: 'claudecode' },
    'codex-cli':   { label: 'Codex',    color: DT.Brand.codex,      creature: 'codex' },
    'openclaw':    { label: 'OpenClaw', color: DT.Brand.openclaw,   creature: 'openclaw' },
    'opencode':    { label: 'OpenCode', color: DT.Brand.opencode,   creature: 'opencode' },
    'antigravity': { label: 'Antigravity', color: DT.Brand.antigravity, creature: 'antigravity' },
    'kiro-cli':    { label: 'Kiro',     color: DT.Brand.kiro,       creature: 'kiro' },
  };

  const STATE_COLOR = {
    processing:   DT.UI.cyan,
    awaiting:     DT.UI.attn,
    idle:         DT.UI.ok,
    disconnected: DT.UI.idleDark,
  };

  const STATE_LABEL = {
    processing: 'Processing',
    awaiting: 'Awaiting',
    idle: 'Idle',
    disconnected: 'Offline',
  };

  // Three mock scenarios exposed via Tweaks
  const SCENARIOS = {
    normal: [
      { id: 's1', agent: 'claude-code', project: 'AgentDeck', model: 'opus-4-6', state: 'processing', tool: 'Bash · pnpm build', started: '12m' },
      { id: 's2', agent: 'codex-cli',   project: 'apme-tuner', model: 'gpt-5.4', state: 'idle',      tool: null, started: '2h' },
      { id: 's3', agent: 'opencode',    project: 'firmware-esp32', model: 'sonnet-4-5', state: 'idle', tool: null, started: '4h' },
    ],
    attention: [
      { id: 's1', agent: 'claude-code', project: 'AgentDeck', model: 'opus-4-6', state: 'awaiting', tool: 'Write file', attention: 'Write to src/apme/runner.ts?', started: '18m' },
      { id: 's2', agent: 'codex-cli',   project: 'apme-tuner', model: 'gpt-5.4', state: 'processing', tool: 'Read · runner.ts', started: '5m' },
      { id: 's3', agent: 'openclaw',    project: 'gateway',    model: 'glm-5.1',  state: 'processing', tool: 'WebFetch', started: '1m' },
      { id: 's4', agent: 'opencode',    project: 'firmware',   model: 'sonnet-4-5', state: 'idle', tool: null, started: '6h' },
    ],
    empty: [],
  };

  const SERVICES = [
    { key: 'claude',   label: 'Claude',   status: 'ok',   detail: 'OAuth · Opus 4.6, Sonnet 4.5, Haiku 4.5' },
    { key: 'openclaw', label: 'OpenClaw', status: 'ok',   detail: 'Gateway :18789' },
    { key: 'mlx',      label: 'MLX',      status: 'ok',   detail: 'Qwen3-1.7B · local fallback' },
    { key: 'ollama',   label: 'Ollama',   status: 'warn', detail: 'Stopped' },
  ];

  const RATE_LIMITS = {
    fiveHour: { pct: 62, resetIn: '2h 14m', trend: 'up' },
    sevenDay: { pct: 34, resetIn: '4d 8h',  trend: 'down' },
  };

  const DEVICES = [
    { kind: 'streamdeck', name: 'Stream Deck+',      status: 'connected', detail: '8 keys · 4 encoders' },
    { kind: 'd200h',      name: 'Ulanzi D200H',      status: 'connected', detail: 'HID · 960×540' },
    { kind: 'android',    name: 'Lenovo Tab',         status: 'connected', detail: 'tablet · 10.1"' },
    { kind: 'eink',       name: 'Crema S',            status: 'connected', detail: 'B&W e-ink' },
    { kind: 'pixoo',      name: 'Pixoo64',            status: 'connected', detail: 'LED 64×64' },
    { kind: 'esp32',      name: 'ESP32 AMOLED',       status: 'reconnecting', detail: 'WiFi · 1.8"' },
    { kind: 'tui',        name: 'TUI (iTerm2)',       status: 'connected', detail: 'braille' },
    { kind: 'tc001',      name: 'TC001 Matrix',       status: 'idle',      detail: '8×32 LED' },
  ];

  window.AD = { AGENTS, STATE_COLOR, STATE_LABEL, SCENARIOS, SERVICES, RATE_LIMITS, DEVICES };
})();
