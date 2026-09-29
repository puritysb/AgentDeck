import { privateRoot, privateOutput, safeName, recordManifest, claimAttempt } from './apme-serving-evidence.mjs';
/** Replay selected private tasks through the production task Runner into isolated SQLite copies.
 * Usage: BENCH_PROFILE=unique-profile node scripts/apme-serving-normalized.mjs PRIVATE_DIR mlx|ollama
 * Normalizes output=800, temperature=0, top_p=1, seed=42, thinking off.
 * Sequence: first + immediate repeat for each fixture, then revisit all fixtures.
 * Keep each profile directory unique: existing attempts are immutable checkpoints.
 * PRIVATE_DIR must contain fixture.sqlite and selection.json; no daemon is started.
 */
import { constants, copyFileSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

const root = privateRoot(process.argv[2]);
const backend = process.argv[3];
if (!['capture', 'mlx', 'ollama'].includes(backend) || !existsSync(join(root, 'selection.json')))
  throw new Error('Invalid private fixture directory or backend');
process.umask(0o077);
const selected = JSON.parse(readFileSync(join(root, 'selection.json'), 'utf8'));
for (const entry of selected) safeName(entry.case);
if (new Set(selected.map((entry) => entry.case)).size !== selected.length)
  throw new Error('Duplicate case identifiers');
const output = privateOutput(root, process.env.BENCH_PROFILE ?? backend);
const manifestSha256 = recordManifest(
  root,
  output,
  {
    mode: 'normalized',
    backend,
    mlxModel: 'mlx-community/gemma-4-26b-a4b-it-4bit',
    ollamaModel: 'foundby-gemma4-ad:16k',
    output: 800,
    temperature: 0,
    topP: 1,
    seed: 42,
    thinking: false,
  },
  ['fixture.sqlite', 'selection.json'],
);
process.env.AGENTDECK_DATA_DIR = privateOutput(output, 'config');
const settingsFile = join(process.env.AGENTDECK_DATA_DIR, 'settings.json');
if (!existsSync(settingsFile))
  writeFileSync(
    settingsFile,
    JSON.stringify({
      llm: { mlx: { model: 'mlx-community/gemma-4-26b-a4b-it-4bit', endpoint: 'http://127.0.0.1:8800' } },
    }),
    { flag: 'wx' },
  );
const { ApmeStore } = await import('../bridge/dist/apme/store.js');
const { ApmeRunner } = await import('../bridge/dist/apme/runner.js');
const { DEFAULT_APME_CONFIG } = await import('../bridge/dist/apme/settings.js');
const originalFetch = globalThis.fetch;
if (backend === 'ollama' && !existsSync(join(output, 'ollama-preload.json'))) {
  const started = performance.now();
  const response = await originalFetch('http://127.0.0.1:11434/api/generate', {
    redirect: 'error',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'foundby-gemma4-ad:16k', keep_alive: '30m' }),
    signal: AbortSignal.timeout(90000),
  });
  if (!response.ok) throw new Error('Ollama preload failed');
  writeFileSync(
    join(output, 'ollama-preload.json'),
    JSON.stringify({ elapsed_s: (performance.now() - started) / 1000, response: await response.json() }),
  );
}

let calls = [];
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (!/^http:\/\/127\.0\.0\.1:(8800|11434)\//.test(url))
    throw new Error(`Network outside local evaluation endpoints blocked: ${url}`);
  if (init?.body) {
    const body = JSON.parse(init.body);
    if (body.messages) {
      body.max_tokens = 800;
      body.temperature = 0;
      body.top_p = 1;
      body.seed = 42;
      if (backend === 'mlx') body.enable_thinking = false;
      else body.reasoning_effort = 'none';
      init = { ...init, body: JSON.stringify(body) };
    }
  }
  const started = performance.now();
  const record = { url, request: init?.body ? JSON.parse(init.body) : null };
  calls.push(record);
  try {
    const response = await originalFetch(input, { ...init, redirect: 'error' });
    record.status = response.status;
    record.response = await response.clone().text();
    record.elapsed_s = (performance.now() - started) / 1000;
    return response;
  } catch (e) {
    record.error = String(e);
    record.elapsed_s = (performance.now() - started) / 1000;
    throw e;
  }
};
const schedule = selected
  .flatMap((selectedCase) => [1, 2].map((rep) => ({ selectedCase, rep })))
  .concat(selected.map((selectedCase) => ({ selectedCase, rep: 3 })));
for (const { selectedCase, rep } of schedule) {
  {
    const name = `${selectedCase.case}-${rep}`;
    const file = join(output, `${name}.json`);
    if (existsSync(file)) continue;
    const dbPath = join(output, `${name}.sqlite`);
    if (existsSync(dbPath)) throw new Error(`Incomplete attempt exists: ${dbPath}`);
    claimAttempt(output, name);
    copyFileSync(join(root, 'fixture.sqlite'), dbPath, constants.COPYFILE_EXCL);
    chmodSync(dbPath, 0o600);
    const db = new DatabaseSync(dbPath);
    db.prepare('DELETE FROM evals WHERE task_id=?').run(selectedCase.taskId);
    // Keep manual outcome in the fixture: Runner must preserve it while replacing the score.
    db.prepare('UPDATE tasks SET composite_score=NULL,summary=NULL WHERE id=?').run(selectedCase.taskId);
    db.close();
    const store = new ApmeStore(dbPath);
    if (!(await store.init())) throw new Error(store.lastInitError);
    const task = store.getTask(selectedCase.taskId);
    const runner = new ApmeRunner(store);
    runner._setConfig({
      ...DEFAULT_APME_CONFIG,
      enabled: true,
      deterministic: { enabled: false, timeoutSec: 30, commands: {} },
      judge: {
        backend: backend === 'ollama' ? 'openai' : 'mlx',
        model: backend === 'ollama' ? 'foundby-gemma4-ad:16k' : 'mlx-community/gemma-4-26b-a4b-it-4bit',
        endpoint: backend === 'ollama' ? 'http://127.0.0.1:11434/v1' : 'http://127.0.0.1:8800/v1/chat/completions',
        ...(backend === 'ollama' ? { reasoningEffort: 'none' } : {}),
        sampleRate: 1,
        onlyWhenDisagreement: false,
        fallbackToFoundationModels: false,
        fallbackToMlx: false,
      },
    });
    let captured;
    if (backend === 'capture')
      runner._setJudgeFn(async (prompt) => {
        captured = prompt;
        return '{"completion":0,"coherence":0,"efficiency":0,"overall":0,"summary":"fixture capture","reasoning":"fixture capture"}';
      });
    const notifications = [];
    runner.onTaskEvaluated((event) =>
      notifications.push({ ...event, saved_at_event: store.listEvalsForTask(event.taskId).length }),
    );
    calls = [];
    const start = performance.now();
    // The same implementation enqueueTask invokes. Await it to checkpoint the completed transaction.
    const status = await runner.runTaskEval({ runId: task.runId, taskId: selectedCase.taskId });
    const elapsed_s = (performance.now() - start) / 1000;
    const evals = store.listEvalsForTask(selectedCase.taskId);
    const updated = store.getTask(selectedCase.taskId);
    store.close();
    const verification = new DatabaseSync(dbPath, { readOnly: true });
    const persisted = verification
      .prepare('SELECT task_id,run_id,layer,metric FROM evals WHERE task_id=?')
      .all(selectedCase.taskId);
    verification.close();
    const prompt =
      captured ?? calls.find((c) => c.request?.messages)?.request.messages.find((m) => m.role === 'user')?.content;
    const result = {
      manifestSha256,
      ...selectedCase,
      backend,
      rep,
      status,
      elapsed_s,
      evals,
      updated,
      notifications,
      calls,
      prompt_sha256: prompt ? createHash('sha256').update(prompt).digest('hex') : null,
      prompt_chars: prompt?.length,
      ...(backend === 'capture' ? { prompt } : {}),
      checks: {
        four_axes: ['completion', 'coherence', 'efficiency', 'overall'].every((axis) =>
          evals.some((e) => e.layer === 'task_judge' && e.metric === axis),
        ),
        correct_task:
          persisted.length > 0 && persisted.every((e) => e.task_id === selectedCase.taskId && e.run_id === task.runId),
        event_after_store: notifications.length === 1 && notifications[0].saved_at_event === evals.length,
        outcome_preserved: task.outcome === null || updated.outcome === task.outcome,
      },
    };
    try {
      const health = await originalFetch('http://127.0.0.1:8800/v1/cache/stats', {
        redirect: 'error',
        signal: AbortSignal.timeout(2000),
      });
      result.cache = await health.json();
    } catch {}
    writeFileSync(file, JSON.stringify(result, null, 2), { flag: 'wx' });
    console.log(
      JSON.stringify({
        case: selectedCase.case,
        backend,
        rep,
        s: Math.round(elapsed_s * 100) / 100,
        chars: prompt?.length,
        checks: result.checks,
        status,
      }),
    );
    if (status === false) console.log('FAILURE PRESERVED ' + name);
  }
}
