// Developer-only: real standalone OpenCode TUI, emitted observer, loopback model.
// Run from the repository root. Existing sessions and provider keys are untouched.
import { createServer } from 'node:http';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { opencodePluginSource } from '../../../hooks/dist/opencode-install.js';

const require = createRequire(new URL('../../../bridge/package.json', import.meta.url));
const pty = require('node-pty');
const kind = process.argv[2] || 'phone';
if (!['phone', 'deck'].includes(kind)) throw new Error('Choose phone or deck');
const timeoutMs = Number(process.env.AGENTDECK_ACCEPTANCE_TIMEOUT_MS || 180_000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3_600_000) throw new Error('Acceptance timeout must be 1000..3600000 ms');
const root = fs.mkdtempSync(join(tmpdir(), `agentdeck-device-acceptance-${kind}-`));
const label = kind === 'phone' ? 'Phone acceptance' : 'Deck acceptance';
const state = { stage: 'starting', calls: 0, toolResults: [] };

function reply(res, body, block, done) {
  const message = {
    id: `msg_device_${Date.now()}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
    content: [block], stop_reason: done ? 'end_turn' : 'tool_use', stop_sequence: null,
    usage: { input_tokens: 20, output_tokens: 20 },
  };
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(message));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (type, fields) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
  send('message_start', { message: { ...message, content: [], stop_reason: null } });
  send('content_block_start', { index: 0, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } });
  send('content_block_delta', { index: 0, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } });
  send('content_block_stop', { index: 0 });
  send('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 20 } });
  send('message_stop', {});
  res.end();
}

const model = createServer(async (req, res) => {
  try {
    if (req.url === '/status') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ root, kind, ...state }));
      return;
    }
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 2_000_000) { res.writeHead(413); res.end(); return; }
    }
    let body;
    try { body = JSON.parse(raw); } catch { res.writeHead(400); res.end(); return; }
    if (req.url.includes('count_tokens')) { res.end(JSON.stringify({ input_tokens: 10 })); return; }
    fs.writeFileSync(join(root, `request-${state.calls++}.json`), JSON.stringify(body, null, 2));
    // OpenCode also asks this provider for a title. A title request must not
    // manufacture a second question or advance the acceptance state.
    if (!(body.tools || []).some(tool => tool.name === 'question')) {
      reply(res, body, { type: 'text', text: 'Device acceptance' }, true);
      return;
    }
    state.toolResults = (body.messages || []).flatMap(m => Array.isArray(m.content) ? m.content : []).filter(p => p.type === 'tool_result');
    const first = JSON.stringify(state.toolResults[0]?.content || '');
    state.stage = state.toolResults.some(r => r.is_error) ? 'tool-error'
      : first.includes('Review only') ? 'review'
      : state.toolResults.length > 0 && !first.includes(label) ? 'unexpected-answer'
      : state.toolResults.length >= 2 ? 'complete'
      : state.toolResults.length === 1 ? 'permission' : 'question';
    const done = !['question', 'permission'].includes(state.stage);
    const block = done ? { type: 'text', text: `Device acceptance ${state.stage}.` }
      : state.stage === 'question' ? {
        type: 'tool_use', id: 'toolu_device_question', name: 'question',
        input: { questions: [{ question: 'Device acceptance: choose the test target', header: 'Device check', options: [
          { label, description: 'Continue the isolated device acceptance' },
          { label: 'Review only', description: 'End this test without executing a tool' },
        ], multiple: false, custom: false }] },
      } : {
        type: 'tool_use', id: 'toolu_device_permission', name: 'bash',
        input: { command: 'node -e \'process.stdout.write("agentdeck_device_acceptance_probe")\'', description: 'Harmless isolated device permission acceptance' },
      };
    reply(res, body, block, done);
  } catch {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});
model.requestTimeout = 15_000;
await new Promise((resolve, reject) => { model.once('error', reject); model.listen(0, '127.0.0.1', resolve); });

const config = join(root, 'config/opencode');
fs.mkdirSync(join(config, 'plugins'), { recursive: true });
fs.writeFileSync(join(config, 'plugins/agentdeck.js'), opencodePluginSource());
fs.writeFileSync(join(config, 'opencode.json'), JSON.stringify({
  model: 'anthropic/claude-sonnet-4-6',
  provider: { anthropic: { options: { baseURL: `http://127.0.0.1:${model.address().port}`, apiKey: 'isolated-local-fixture' } } },
  permission: { '*': 'allow', bash: 'ask' }, autoupdate: false, share: 'disabled',
}));
const env = { ...process.env };
for (const key of ['AGENTDECK_PORT', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT']) delete env[key];
Object.assign(env, {
  XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'),
  XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
  OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1',
  OPENCODE_DISABLE_MODELS_FETCH: '1', ANTHROPIC_API_KEY: 'isolated-local-fixture', TERM: 'xterm-256color',
});
let child;
try {
  child = pty.spawn(process.env.AGENTDECK_ACCEPTANCE_OPENCODE_BINARY || 'opencode', [
    '--prompt', 'Run the isolated device acceptance using the question tool, then the harmless bash tool.',
  ], { cwd: root, env, cols: 110, rows: 35, name: 'xterm-256color' });
} catch (error) { model.closeAllConnections(); model.close(); throw error; }
const stop = () => { try { child.kill(); } catch { /* already exited */ } };
process.once('exit', stop);
child.onData(data => fs.appendFileSync(join(root, 'tui.log'), data));
const exited = new Promise(resolve => child.onExit(resolve));
const timeout = setTimeout(() => { console.error('Acceptance deadline reached; closing isolated OpenCode'); process.exitCode = 1; stop(); }, timeoutMs);
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, stop);
const metadata = { root, kind, pid: child.pid, orchestratorPid: process.pid, modelPort: model.address().port };
fs.writeFileSync(join(root, 'run.json'), JSON.stringify(metadata));
fs.mkdirSync('diagnostics', { recursive: true });
fs.writeFileSync(`diagnostics/${kind}-acceptance-run.json`, JSON.stringify(metadata));
console.log(JSON.stringify(metadata));
await exited;
clearTimeout(timeout);
model.closeAllConnections();
model.close();
