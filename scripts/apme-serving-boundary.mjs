import { privateRoot, privateOutput, safeName, recordManifest, claimAttempt } from './apme-serving-evidence.mjs';
/** Run synthetic context boundaries through the actual judge HTTP adapter. Private evidence only. */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const root = privateRoot(process.argv[2]);
const backend = process.argv[3];
if (!['mlx', 'ollama'].includes(backend) || !existsSync(join(root, 'boundaries.json')))
  throw new Error('Invalid fixture');
process.umask(0o077);
const fixtures = JSON.parse(readFileSync(join(root, 'boundaries.json'), 'utf8'));
for (const fixture of fixtures) safeName(fixture.case);
if (new Set(fixtures.map((f) => f.case)).size !== fixtures.length) throw new Error('Duplicate case identifiers');
const output = privateOutput(root, process.env.BENCH_PROFILE ?? `boundary-${backend}`);
const manifestSha256 = recordManifest(root, output, { mode: 'boundary', backend }, ['boundaries.json']);
process.env.AGENTDECK_DATA_DIR = privateOutput(output, 'config');
const { callJudgeWithMeta, parseJudgeJson } = await import('../bridge/dist/apme/runner.js');
const cfg = {
  backend: backend === 'mlx' ? 'mlx' : 'openai',
  model: backend === 'mlx' ? 'mlx-community/gemma-4-26b-a4b-it-4bit' : 'foundby-gemma4-ad:16k',
  endpoint: backend === 'mlx' ? 'http://127.0.0.1:8800/v1/chat/completions' : 'http://127.0.0.1:11434/v1',
  fallbackToMlx: false,
  fallbackToFoundationModels: false,
};
if (backend === 'ollama') cfg.reasoningEffort = 'none';
const original = globalThis.fetch;
let calls = [];
globalThis.fetch = async (input, init) => {
  if (!/^http:\/\/127\.0\.0\.1:(8800|11434)\//.test(String(input))) throw new Error('Non-local request blocked');
  const c = { url: String(input), request: init?.body ? JSON.parse(init.body) : null };
  calls.push(c);
  const start = performance.now();
  try {
    const r = await original(input, { ...init, redirect: 'error' });
    c.status = r.status;
    c.response = await r.clone().text();
    c.elapsed_s = (performance.now() - start) / 1000;
    return r;
  } catch (e) {
    c.error = String(e);
    throw e;
  }
};
for (const fixture of fixtures) {
  const path = join(output, `boundary-${backend}-${fixture.case}.json`);
  if (existsSync(path)) continue;
  claimAttempt(output, `boundary-${backend}-${fixture.case}`);
  calls = [];
  const start = performance.now();
  let result, error;
  try {
    result = await callJudgeWithMeta(fixture.prompt, cfg);
  } catch (e) {
    error = String(e);
  }
  const record = {
    manifestSha256,
    backend,
    ...fixture,
    result,
    error,
    calls,
    elapsed_s: (performance.now() - start) / 1000,
    parseable: result ? !!parseJudgeJson(result.text) : false,
  };
  writeFileSync(path, JSON.stringify(record, null, 2), { flag: 'wx' });
  console.log(
    JSON.stringify({
      backend,
      case: fixture.case,
      s: record.elapsed_s,
      parseable: record.parseable,
      error,
      calls: calls.length,
    }),
  );
}
