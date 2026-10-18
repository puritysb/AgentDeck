import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { ApmeStore, type ApmeLocalVerdictRow, type ApmeReferenceEvalRow } from '../apme/store.js';
import { ApmeCollector } from '../apme/collector.js';
import { ApmeRunner, buildTaskJudgeInput } from '../apme/runner.js';
import type { ApmeConfig } from '../apme/settings.js';
import {
  CODEX_FIXED_INPUT_TOKENS,
  REFERENCE_DISABLED_FEATURES,
  buildReferenceInput,
  buildReferenceReports,
  codexDefaultModel,
  codexJudgeArgs,
  computeAgreement,
  estimateCodexInputTokens,
  handledSince,
  isolationBreach,
  parkedReferenceTasks,
  parseCodexExecEvents,
  parseReferenceUntil,
  pickReferenceCandidates,
  planReferenceRun,
  promptSha,
  redactForEgress,
  referenceEvalRow,
  referencePicksDigest,
  referenceRunCommand,
  referenceSampleLabel,
  runCodexJudge,
  stderrReason,
  verdictSchemaFromRubric,
  withInterruptAbort,
  type CodexJudgeResult,
  type ReferenceInput,
} from '../apme/reference-judge.js';

/**
 * The reference judge (`agentdeck apme reference-judge`) scores tasks the
 * local judge already scored, through `codex exec`, so the local judge can be
 * measured. These tests pin what makes that number mean anything: both judges
 * see one prompt, the reference verdict never reaches the product's own evals,
 * and the codex call is isolated from the daemon that observes Codex.
 */

async function makeStore(): Promise<ApmeStore> {
  const dir = mkdtempSync(join(tmpdir(), 'apme-refjudge-'));
  const store = new ApmeStore(join(dir, 'apme.sqlite'));
  if (!(await store.init())) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error('APME store failed to initialize — is better-sqlite3 installed?');
  }
  (store as unknown as { _tmpDir: string })._tmpDir = dir;
  return store;
}
function cleanup(store: ApmeStore): void {
  store.close();
  const dir = (store as unknown as { _tmpDir?: string })._tmpDir;
  if (dir) rmSync(dir, { recursive: true, force: true });
}

const STUB_CONFIG: ApmeConfig = {
  enabled: true,
  deterministic: { enabled: false, timeoutSec: 30, commands: {} },
  judge: { backend: 'mlx', endpoint: 'http://stub', model: 'stub', sampleRate: 1, onlyWhenDisagreement: false },
  availableModels: [],
};

// Verbatim `codex exec --json` output, codex-cli 0.160.1, 2026-10-18, for a
// synthetic pagination task (no user data).
const CAPTURED_EVENTS = [
  '{"type":"thread.started","thread_id":"01a14c03-24b0-7333-89ea-3a7c625fbadb"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"{\\"summary\\":\\"The pagination fix is direct and passes tests, but the claimed regression test is not supported by the trajectory.\\",\\"completion\\":0.9,\\"coherence\\":0.85,\\"efficiency\\":1,\\"overall\\":0.9,\\"reasoning\\":\\"Changing slice(start - 1, end) to slice(start, end) directly addresses the repeated boundary item, and all three pagination tests passed. The final response claims a regression test was added, but no test edit appears in the recorded actions.\\",\\"done\\":[\\"Corrected the slice start index.\\",\\"Ran pagination tests with three passing.\\"],\\"missed\\":[\\"No recorded addition of the claimed page-boundary regression test.\\"]}"}}',
  '{"type":"turn.completed","usage":{"input_tokens":17141,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":144,"reasoning_output_tokens":0}}',
].join('\n');

// Verbatim lines from the same Codex, 2026-10-18, synthetic prompts that asked
// the model to check a claim itself. With the shell on under `-s read-only`:
const CAPTURED_SHELL_CALL = [
  '{"type":"item.started","item":{"id":"item_0","type":"command_execution","command":"/bin/zsh -lc \\"test -f /etc/hosts && rg -n \'(\\"\'^|[[:space:]])localhost([[:space:]]|$)\'\\"\' /etc/hosts\\"","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"/bin/zsh -lc \\"test -f /etc/hosts && rg -n \'(\\"\'^|[[:space:]])localhost([[:space:]]|$)\'\\"\' /etc/hosts\\"","aggregated_output":"4:# localhost is used to configure the loopback interface\\n7:127.0.0.1\\tlocalhost\\n9:::1             localhost\\n","exit_code":0,"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"{\\"overall\\":1,\\"reasoning\\":\\"Verified that /etc/hosts exists and contains localhost entries for 127.0.0.1 and ::1. The claim is correct.\\",\\"checked_with_tool\\":true}"}}',
].join('\n');
// Web search, on by default even under --ignore-user-config (the item carries
// its id twice; the second wins):
const CAPTURED_WEB_SEARCH_START =
  '{"type":"item.started","item":{"id":"item_0","type":"web_search","id":"exec-5ed03a70-5ae5-4f3e-b6f4-8152e247b2e6","query":"","action":{"type":"other"}}}';
// An unknown `-c` key, which Codex reports and then ignores:
const CAPTURED_IGNORED_SETTING =
  '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Codex is ignoring 1 unrecognized configuration setting. Check for typos or deprecated settings.\\n  session-flags: `no_such_key_xyz` is ignored."}}';
// The notice every run with `--disable code_mode_host` starts with:
const CAPTURED_CODE_MODE_OFF =
  '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`."}}';

describe('one prompt for both judges', () => {
  let store!: ApmeStore;
  beforeEach(async () => { store = await makeStore(); });
  afterEach(() => { cleanup(store); });

  it('buildTaskJudgeInput produces exactly the prompt the live task judge sends', async () => {
    const collector = new ApmeCollector(store);
    const runner = new ApmeRunner(store);
    runner._setConfig(STUB_CONFIG);
    const sent: string[] = [];
    runner._setJudgeFn(async (p) => { sent.push(p); return JSON.stringify({ overall: 0.8, reasoning: 'r', summary: 'Fixed it', done: [], missed: [] }); });

    const runId = collector.openRun({ sessionId: 's1', agentType: 'claude-code', projectName: 'demo' })!;
    collector.ingestHook('s1', 'UserPromptSubmit', { prompt: 'fix the flaky retry test' });
    collector.ingestHook('s1', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'pnpm test retry' } });
    collector.setTurnResponse('s1', 'Fixed the race in the retry helper and re-ran the suite.');
    const taskId = collector.getActiveTaskId('s1')!;
    collector.noteTurnStop('s1');
    collector.closeRun('s1');
    store.updateRun(runId, { taskCategory: 'debugging' });

    runner.enqueueTask({ runId, taskId, boundarySignal: 'session_end' });
    await runner.drain();

    const input = buildTaskJudgeInput(store, { runId, taskId, boundarySignal: 'session_end' });
    expect(input.kind).toBe('ready');
    expect(sent).toHaveLength(1);
    expect(input.kind === 'ready' && input.prompt).toBe(sent[0]);
    // The reference path records the same local prompt, and with nothing to
    // redact it sends that prompt unchanged.
    const reference = buildReferenceInput(store, { runId, taskId });
    expect(reference.kind === 'ready' && reference.local.prompt).toBe(sent[0]);
    expect(reference.kind === 'ready' && reference.prompt).toBe(sent[0]);
  });

  it('redacts each field before it is clipped, and leaves the local prompt as the live judge sent it', async () => {
    const collector = new ApmeCollector(store);
    const runner = new ApmeRunner(store);
    runner._setConfig(STUB_CONFIG);
    const sent: string[] = [];
    runner._setJudgeFn(async (p) => { sent.push(p); return JSON.stringify({ overall: 0.8, reasoning: 'r', summary: 'Deployed', done: [], missed: [] }); });
    // A ~1,700-character key in a 1,500-character field: the clip cuts its END line.
    const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const keyLines = Array.from({ length: 25 }, (_, line) => Array.from({ length: 64 }, (_, i) => B64[((line * 64 + i) * 37 + 11) % 64]).join(''));
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${keyLines.join('\n')}\n-----END RSA PRIVATE KEY-----`;
    expect(pem.length).toBeGreaterThan(1_650);

    const runId = collector.openRun({ sessionId: 's3', agentType: 'claude-code', projectName: 'demo' })!;
    collector.ingestHook('s3', 'UserPromptSubmit', { prompt: `Deploy with this key:\n${pem}\nThen restart the service.` });
    collector.ingestHook('s3', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'systemctl restart app' } });
    collector.setTurnResponse('s3', 'Deployed with the key and restarted the service.');
    const taskId = collector.getActiveTaskId('s3')!;
    collector.noteTurnStop('s3');
    collector.closeRun('s3');
    store.updateRun(runId, { taskCategory: 'ops' });
    runner.enqueueTask({ runId, taskId, boundarySignal: 'session_end' });
    await runner.drain();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(keyLines[20]);
    expect(sent[0]).not.toContain('-----END RSA PRIVATE KEY-----');

    const input = buildReferenceInput(store, { runId, taskId });
    if (input.kind !== 'ready') throw new Error(`expected a ready input, got ${input.kind}`);
    expect(input.local.prompt).toBe(sent[0]);
    for (const line of keyLines) expect(input.prompt).not.toContain(line);
    expect(input.prompt).not.toContain('PRIVATE KEY');
    // Redacted inside its field, not by the cut-key fallback over the whole
    // prompt, which would have taken the rest of the prompt with it.
    expect(input.prompt).toContain('Deployed with the key and restarted the service.');
    expect(input.prompt).toContain('Respond with strict JSON only.');
    expect(input.redactions).toBe(1);
  });

  it('declines a task the live judge would decline, and writes nothing', async () => {
    const collector = new ApmeCollector(store);
    const runId = collector.openRun({ sessionId: 's2', agentType: 'codex-cli', projectName: 'demo' })!;
    collector.ingestHook('s2', 'UserPromptSubmit', { prompt: 'fix the flaky test please' });
    const taskId = collector.getActiveTaskId('s2')!;
    collector.noteTurnStop('s2');
    collector.closeRun('s2');
    const before = store.getTask(taskId)!.notesJson;

    expect(buildTaskJudgeInput(store, { runId, taskId })).toEqual({ kind: 'declined', reason: 'no_reply' });
    expect(store.getTask(taskId)!.notesJson).toBe(before);
    expect(buildTaskJudgeInput(store, { runId, taskId: 'no-such-task' })).toEqual({ kind: 'missing' });
  });
});

describe('verdict schema from the rubric template', () => {
  let store!: ApmeStore;
  beforeEach(async () => { store = await makeStore(); });
  afterEach(() => { cleanup(store); });

  it('turns the seeded task_rollup template into a strict schema', () => {
    const schema = verdictSchemaFromRubric(store.getCurrentRubric('task_rollup')!.prompt);
    expect(schema).toEqual({
      type: 'object',
      properties: {
        summary: { type: 'string' },
        completion: { type: 'number' },
        coherence: { type: 'number' },
        efficiency: { type: 'number' },
        overall: { type: 'number' },
        reasoning: { type: 'string' },
        done: { type: 'array', items: { type: 'string' } },
        missed: { type: 'array', items: { type: 'string' } },
      },
      required: ['summary', 'completion', 'coherence', 'efficiency', 'overall', 'reasoning', 'done', 'missed'],
      additionalProperties: false,
    });
  });

  it('reads every seeded category rubric, so a template edit that breaks it fails here', () => {
    for (const purpose of ['conversation', 'planning', 'research', 'debugging', 'refactoring', 'review', 'ops']) {
      const rubric = store.getCurrentRubric(purpose);
      expect(rubric, purpose).not.toBeNull();
      const schema = verdictSchemaFromRubric(rubric!.prompt) as { required: string[] } | null;
      expect(schema?.required, purpose).toContain('overall');
    }
  });

  it('returns null rather than guessing when there is no template', () => {
    expect(verdictSchemaFromRubric('Score this. Respond with JSON.')).toBeNull();
    expect(verdictSchemaFromRubric('Return strict JSON: {"overall":N, "nested":{"a":1}}')).toBeNull();
    expect(verdictSchemaFromRubric('Return strict JSON: {"completion":N}')).toBeNull();
  });
});

describe('codex exec', () => {
  it('reads the verdict and token usage from captured JSONL', () => {
    const outcome = parseCodexExecEvents(CAPTURED_EVENTS);
    expect(outcome.error).toBeNull();
    expect(outcome.usage).toEqual({ inputTokens: 17141, cachedInputTokens: 0, outputTokens: 144, reasoningTokens: 0 });
    expect(JSON.parse(outcome.text!).overall).toBe(0.9);
  });

  it('reports a failed turn and skips lines that are not JSON', () => {
    const outcome = parseCodexExecEvents([
      'Reading prompt from stdin...',
      '{"type":"turn.started"}',
      '{"type":"turn.failed","error":{"message":"usage limit reached"}}',
    ].join('\n'));
    expect(outcome).toEqual({ text: null, usage: null, error: 'usage limit reached', toolItems: [], warnings: [] });
    expect(parseCodexExecEvents('{"type":"error","message":"stream disconnected"}').error).toBe('stream disconnected');
  });

  it('a verdict reached through a tool is not a reference verdict', () => {
    const shell = parseCodexExecEvents(CAPTURED_SHELL_CALL);
    expect(shell.toolItems).toEqual(['command_execution']);
    expect(shell.text).not.toBeNull();
    expect(isolationBreach(shell)).toBe('the reference called a tool (command_execution)');

    // A call that never completed still counts.
    const web = parseCodexExecEvents([CAPTURED_WEB_SEARCH_START, CAPTURED_EVENTS].join('\n'));
    expect(web.toolItems).toEqual(['web_search']);
    expect(isolationBreach(web)).toMatch(/web_search/);
    expect(isolationBreach(parseCodexExecEvents(CAPTURED_EVENTS))).toBeNull();
  });

  it('a setting Codex ignored fails the run; the code-mode notice does not', () => {
    const ignored = parseCodexExecEvents([CAPTURED_IGNORED_SETTING, CAPTURED_EVENTS].join('\n'));
    expect(ignored.warnings).toHaveLength(1);
    expect(isolationBreach(ignored)).toMatch(/^codex ignored a setting: .*no_such_key_xyz/);

    const codeModeOff = parseCodexExecEvents([CAPTURED_CODE_MODE_OFF, CAPTURED_EVENTS].join('\n'));
    expect(codeModeOff.warnings).toHaveLength(1);
    expect(codeModeOff.toolItems).toEqual([]);
    expect(isolationBreach(codeModeOff)).toBeNull();
  });

  it('keeps every isolation flag: no rollout, no user config (hooks), no tools, no web, prompt on stdin', () => {
    const args = codexJudgeArgs({ model: 'm', effort: 'high', cwd: '/scratch/cwd', schemaPath: '/scratch/s.json' });
    expect(args[0]).toBe('exec');
    expect(args).toContain('--ephemeral');
    expect(args).toContain('--ignore-user-config');
    expect(args.join(' ')).toContain('-s read-only');
    // Named here, not read back from the list, so dropping one fails.
    for (const feature of ['shell_tool', 'unified_exec', 'code_mode_host', 'view_image', 'apps', 'plugins', 'multi_agent', 'hooks']) {
      expect(args.join(' ')).toContain(`--disable ${feature}`);
    }
    for (const feature of REFERENCE_DISABLED_FEATURES) expect(args.join(' ')).toContain(`--disable ${feature}`);
    expect(args.join(' ')).toContain('-c web_search=disabled');
    expect(args.join(' ')).toContain('-C /scratch/cwd');
    expect(args.join(' ')).toContain('-m m');
    expect(args.join(' ')).toContain('-c model_reasoning_effort=high');
    expect(args.join(' ')).toContain('--output-schema /scratch/s.json');
    expect(args).toContain('--json');
    expect(args[args.length - 1]).toBe('-');
    expect(codexJudgeArgs({ model: 'm', effort: 'low', cwd: '/c', schemaPath: null })).not.toContain('--output-schema');
  });

  it('reads the default model from the top level of config.toml only', () => {
    expect(codexDefaultModel('model = "gpt-6-astra"\nmodel_reasoning_effort = "ultra"\n')).toBe('gpt-6-astra');
    expect(codexDefaultModel('# comment\n[profiles.fast]\nmodel = "gpt-5.6-luna"\n')).toBeNull();
    expect(codexDefaultModel('approval_policy = "never"\n')).toBeNull();
  });
});

describe.skipIf(process.platform === 'win32')('runCodexJudge against a stand-in codex binary', () => {
  let dir!: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'apme-fake-codex-')); });
  afterEach(() => {
    // A grandchild a failing test left running.
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.pid')) continue;
      const pid = Number(readFileSync(join(dir, entry), 'utf-8'));
      if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  // Each stand-in is a cold node start. Under swap pressure one took over the
  // 10 s default (2026-10-18), so these tests allow 30 s: runCodexJudge's own
  // 20 s bound is the one that should fire, and it says what went wrong.
  function fakeCodex(body: string, interpreter = '/usr/bin/env node'): string {
    const path = join(dir, 'codex');
    writeFileSync(path, `#!${interpreter}\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  }

  /** A stand-in shaped like the npm `codex` wrapper: it starts the real work
   *  as a child with inherited stdio, forwards no signal, and waits. It
   *  records the child's pid and the scratch cwd it was given. */
  function wrapperCodex(opts: { ignoreTerm?: boolean } = {}): { binary: string; pidFile: string; cwdFile: string } {
    const pidFile = join(dir, 'grandchild.pid');
    const cwdFile = join(dir, 'cwd.txt');
    const binary = fakeCodex([
      // An ignored signal stays ignored in the child, so neither exits on TERM.
      opts.ignoreTerm ? "trap '' TERM" : '',
      'prev=',
      `for a in "$@"; do if [ "$prev" = "-C" ]; then printf '%s' "$a" > '${cwdFile}'; fi; prev="$a"; done`,
      'sleep 300 &',
      `echo $! > '${pidFile}.tmp' && mv '${pidFile}.tmp' '${pidFile}'`,
      'wait',
    ].join('\n'), '/bin/sh');
    return { binary, pidFile, cwdFile };
  }

  function grandchildOf(pidFile: string): number {
    expect(existsSync(pidFile), 'the stand-in never started its child (machine overloaded?)').toBe(true);
    return Number(readFileSync(pidFile, 'utf-8'));
  }

  /** Polls, because a killed process is reaped asynchronously. */
  async function goneWithin(pid: number, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    for (;;) {
      try { process.kill(pid, 0); } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ESRCH') return true; }
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  it('sends the prompt on stdin, closes it, and parses the reply', async () => {
    const record = join(dir, 'record.json');
    const binary = fakeCodex(`
      const fs = require('fs');
      let input = '';
      process.stdin.on('data', (c) => { input += c; });
      process.stdin.on('end', () => {
        const args = process.argv.slice(2);
        const cwd = args[args.indexOf('-C') + 1];
        const schema = args[args.indexOf('--output-schema') + 1];
        fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ input, args, cwdEntries: fs.readdirSync(cwd), schema: JSON.parse(fs.readFileSync(schema, 'utf-8')) }));
        console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ overall: 0.4, reasoning: 'r', done: [], missed: ['tests'] }) } }));
        console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 20000, cached_input_tokens: 0, output_tokens: 300, reasoning_output_tokens: 120 } }));
      });
    `);
    const schema = { type: 'object', properties: { overall: { type: 'number' } }, required: ['overall'], additionalProperties: false };
    const result = await runCodexJudge('PROMPT ✓ 한글', { model: 'gpt-x', effort: 'high', schema, binary, timeoutMs: 20_000 });

    expect(result.error).toBeNull();
    expect(result.end).toBe('exited');
    expect(JSON.parse(result.text!).overall).toBe(0.4);
    expect(result.usage).toEqual({ inputTokens: 20000, cachedInputTokens: 0, outputTokens: 300, reasoningTokens: 120 });
    const seen = JSON.parse(readFileSync(record, 'utf-8')) as { input: string; args: string[]; cwdEntries: string[]; schema: unknown };
    expect(seen.input).toBe('PROMPT ✓ 한글');
    expect(seen.cwdEntries).toEqual([]);
    expect(seen.schema).toEqual(schema);
    expect(seen.args).toContain('--ignore-user-config');
    // The scratch directory is removed after the call.
    expect(readdirSync(tmpdir()).some((e) => e.startsWith('agentdeck-refjudge-') && seen.args.join(' ').includes(e))).toBe(false);
  }, 30_000);

  it('kills a call that outlives its timeout and says so', async () => {
    const binary = fakeCodex(`process.stdin.resume(); setInterval(() => {}, 1000);`);
    const result = await runCodexJudge('p', { model: 'm', effort: 'low', schema: null, binary, timeoutMs: 400 });
    expect(result.text).toBeNull();
    expect(result.error).toMatch(/timed out/);
    expect(result.end).toBe('timed_out');
  }, 30_000);

  it('a timeout stops the process tree, not only the process it spawned', async () => {
    // The npm `codex` wrapper runs the native binary with inherited stdio and
    // forwards only SIGINT/SIGTERM/SIGHUP: killing the wrapper alone left the
    // real Codex running with the pipes open.
    const { binary, pidFile, cwdFile } = wrapperCodex();
    const result = await runCodexJudge('p', { model: 'm', effort: 'low', schema: null, binary, timeoutMs: 1_500 });
    expect(result.end).toBe('timed_out');
    expect(result.error).toMatch(/timed out/);
    expect(await goneWithin(grandchildOf(pidFile), 3_000)).toBe(true);
    // The scratch directory is removed once the tree is stopped.
    expect(existsSync(dirname(readFileSync(cwdFile, 'utf-8')))).toBe(false);
  }, 30_000);

  it('a tree that ignores SIGTERM gets SIGKILL after the grace', async () => {
    const { binary, pidFile } = wrapperCodex({ ignoreTerm: true });
    const result = await runCodexJudge('p', { model: 'm', effort: 'low', schema: null, binary, timeoutMs: 1_500, killGraceMs: 300 });
    expect(result.end).toBe('timed_out');
    expect(await goneWithin(grandchildOf(pidFile), 3_000)).toBe(true);
    // It waited out the grace: SIGTERM did not end it, SIGKILL did.
    expect(result.latencyMs).toBeGreaterThanOrEqual(1_500 + 300);
  }, 30_000);

  it('an abort stops the tree, reports interrupted, and removes the scratch directory', async () => {
    const { binary, pidFile, cwdFile } = wrapperCodex();
    const controller = new AbortController();
    const call = runCodexJudge('p', { model: 'm', effort: 'low', schema: null, binary, timeoutMs: 20_000, signal: controller.signal });
    for (let waited = 0; !existsSync(pidFile) && waited < 20_000; waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    controller.abort();
    const result = await call;
    expect(result.end).toBe('interrupted');
    expect(result.error).toBe('interrupted');
    expect(await goneWithin(grandchildOf(pidFile), 3_000)).toBe(true);
    expect(existsSync(dirname(readFileSync(cwdFile, 'utf-8')))).toBe(false);
  }, 30_000);

  it('decodes a character split across two reads', async () => {
    // 가 is EA B0 80; the stand-in writes it in two pieces with a pause between.
    const binary = fakeCodex([
      `printf '%s' '{"type":"item.completed","item":{"type":"agent_message","text":"'`,
      `printf '\\352\\260'`,
      'sleep 0.3',
      `printf '\\200"}}\\n'`,
    ].join('\n'), '/bin/sh');
    const result = await runCodexJudge('p', { model: 'm', effort: 'low', schema: null, binary, timeoutMs: 20_000 });
    expect(result.text).toBe('가');
  }, 30_000);

  it('a binary that cannot be spawned ends not_started', async () => {
    const result = await runCodexJudge('p', { model: 'm', effort: 'low', schema: null, binary: join(dir, 'missing'), timeoutMs: 20_000 });
    expect(result.end).toBe('not_started');
    expect(result.error).toMatch(/could not start/);
  }, 30_000);

  it('a non-zero exit with no verdict says why, from the error line on stderr', async () => {
    const binary = fakeCodex(`process.stdin.resume(); process.stdin.on('end', () => { console.error("error: unexpected argument '--disable' found"); console.error(''); console.error("For more information, try '--help'."); process.exit(2); });`);
    const result = await runCodexJudge('p', { model: 'nope', effort: 'low', schema: null, binary, timeoutMs: 20_000 });
    expect(result.text).toBeNull();
    expect(result.error).toBe("codex exited 2: error: unexpected argument '--disable' found");
  }, 30_000);

  it('withholds a verdict the model reached through a tool', async () => {
    const binary = fakeCodex(`
      process.stdin.resume();
      process.stdin.on('end', () => { process.stdout.write(${JSON.stringify(`${CAPTURED_SHELL_CALL}\n`)}); });
    `);
    const result = await runCodexJudge('p', { model: 'm', effort: 'low', schema: null, binary, timeoutMs: 20_000 });
    expect(result.text).toBeNull();
    expect(result.error).toBe('the reference called a tool (command_execution)');
  }, 30_000);
});

describe('binding a run to its dry run', () => {
  const now = Date.parse('2026-10-18T12:00:00.000Z');

  it('reads --until as epoch ms or an ISO time, and refuses seconds, garbage and the future', () => {
    expect(parseReferenceUntil('2026-10-18T09:00:00.000Z', now)).toEqual({ untilMs: Date.parse('2026-10-18T09:00:00.000Z') });
    expect(parseReferenceUntil(String(now - 5), now)).toEqual({ untilMs: now - 5 });
    expect(parseReferenceUntil('1760000000', now)).toHaveProperty('error');
    expect(parseReferenceUntil('last tuesday', now)).toHaveProperty('error');
    expect(parseReferenceUntil(String(now + 1), now)).toHaveProperty('error');
  });

  it('fingerprints the ordered pick list', () => {
    expect(referencePicksDigest(['a', 'b'])).toMatch(/^[0-9a-f]{12}$/);
    expect(referencePicksDigest(['a', 'b'])).toBe(referencePicksDigest(['a', 'b']));
    expect(referencePicksDigest(['a', 'b'])).not.toBe(referencePicksDigest(['b', 'a']));
    expect(referencePicksDigest(['a', 'b'])).not.toBe(referencePicksDigest(['a']));
  });

  it('prints the --run command with the resolved time, the same arguments and the digest', () => {
    const base = { untilMs: Date.parse('2026-10-18T09:00:00.000Z'), since: '7d', limit: 5, model: 'gpt-x', effort: 'high', seed: 'agentdeck', projects: [] as string[], digest: 'abc123def456' };
    expect(referenceRunCommand(base, 'darwin')).toBe(
      'agentdeck apme reference-judge --run --until 2026-10-18T09:00:00.000Z --since 7d -n 5 --model gpt-x --effort high --seed agentdeck --expect abc123def456');
    const full = referenceRunCommand({ ...base, seed: "it's", category: 'ops', localBand: 'fail', projects: ['My App', 'AgentDeck'], timeoutSec: 600, retryParked: true }, 'darwin');
    expect(full).toContain("--seed 'it'\\''s' --category ops --local-band fail --project 'My App,AgentDeck' --timeout 600 --retry-parked --expect abc123def456");
    expect(referenceRunCommand({ ...base, projects: ['My App'] }, 'win32')).toContain('--project "My App"');
  });
});

describe('what a reference call records', () => {
  const pick: ApmeLocalVerdictRow = {
    taskId: 't', runId: 'r', agentType: 'codex-cli', project: 'p', category: 'coding', endedAt: 1, summary: null,
    localOverall: 1, localJudge: 'mlx:x', localRubricVer: 7, localJudgedAt: 5,
  };
  const input = {
    kind: 'ready',
    local: { kind: 'ready', task: { taskCategory: 'coding' }, category: 'coding', rubric: { version: 7, prompt: '' }, sample: null, prompt: 'LOCAL PROMPT' },
    prompt: 'SENT PROMPT [REDACTED]',
    redactions: 1,
  } as unknown as Extract<ReferenceInput, { kind: 'ready' }>;
  const call = (o: Partial<CodexJudgeResult>): CodexJudgeResult => ({ text: null, usage: null, error: null, toolItems: [], warnings: [], end: 'exited', latencyMs: 10, ...o });
  const row = (result: CodexJudgeResult) => referenceEvalRow({ pick, input, result, judge: 'codex:m@high', sample: 'uniform', createdAt: 99 });

  it('records nothing for a call that was interrupted or never started: neither is about the task', () => {
    expect(row(call({ end: 'interrupted', error: 'interrupted' }))).toBeNull();
    expect(row(call({ end: 'not_started', error: 'could not start codex: spawn codex ENOENT' }))).toBeNull();
  });

  it('records a timeout as a failed attempt, and a verdict under the local prompt\'s hash', () => {
    expect(row(call({ end: 'timed_out', error: 'timed out after 300 s' }))).toMatchObject({ overall: null, error: 'timed out after 300 s', localOverall: 1, createdAt: 99 });
    const verdict = row(call({ text: JSON.stringify({ overall: 0.4, reasoning: 'r', summary: 's', done: [], missed: ['tests'] }) }))!;
    expect(verdict).toMatchObject({ overall: 0.4, error: null, rubricVer: 7, category: 'coding', promptSha: promptSha('LOCAL PROMPT') });
  });
});

describe('interrupting a run', () => {
  const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  const counts = () => SIGNALS.map((s) => process.listenerCount(s));

  it('turns a signal into an abort, once, and removes its handlers afterwards', async () => {
    const baseline = counts();
    const before = process.listeners('SIGTERM');
    const seen: string[] = [];
    const { value, interrupted } = await withInterruptAbort(async (signal) => {
      expect(counts()).toEqual(baseline.map((n) => n + 1));
      // Call the handler directly: emitting the signal would also run the
      // test runner's own handlers.
      const ours = process.listeners('SIGTERM').filter((l) => !before.includes(l)) as Array<(s: NodeJS.Signals) => void>;
      expect(ours).toHaveLength(1);
      ours[0]('SIGTERM');
      ours[0]('SIGTERM');
      return signal.aborted;
    }, (s) => seen.push(s));
    expect(value).toBe(true);
    expect(interrupted).toBe('SIGTERM');
    expect(seen).toEqual(['SIGTERM']);
    expect(counts()).toEqual(baseline);
  });

  it('removes its handlers when the run throws', async () => {
    const baseline = counts();
    await expect(withInterruptAbort(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(counts()).toEqual(baseline);
  });
});

describe('dry-run cost estimate', () => {
  it('adds the fixed part to the prompt at the fitted per-script rates', () => {
    expect(estimateCodexInputTokens('')).toBe(CODEX_FIXED_INPUT_TOKENS);
    expect(estimateCodexInputTokens('a'.repeat(1000))).toBe(CODEX_FIXED_INPUT_TOKENS + 280);
    expect(estimateCodexInputTokens('가'.repeat(1000))).toBe(CODEX_FIXED_INPUT_TOKENS + 910);
  });
});

describe('stderr reason', () => {
  it('prefers the error line, falls back to the last line', () => {
    expect(stderrReason('Error: Unknown feature flag: no_such_feature_xyz\n')).toBe('Error: Unknown feature flag: no_such_feature_xyz');
    expect(stderrReason('warming up\nsomething went wrong\n')).toBe('something went wrong');
    expect(stderrReason('  \n')).toBeNull();
  });
});

describe('redaction before egress', () => {
  // Provider-shaped fixtures are assembled at runtime, so the source never
  // holds a whole token for a secret scanner to match (GitHub push protection
  // refused a literal Hugging Face shape here).
  const join = (...parts: string[]): string => parts.join('');
  it('removes pairing tokens and credential shapes, keeps hashes and ids a judge reads as evidence', () => {
    const token = 'a'.repeat(32) + 'b'.repeat(32);
    const sha = '3c7c6aac0f1e2d3c4b5a69788796a5b4c3d2e1f0';
    const uuid = '01a14c03-24b0-7333-89ea-3a7c625fbadb';
    const text = [
      `curl -H "Authorization: Bearer ${token}" http://127.0.0.1:9120/health`,
      `ws://host:9120/?token=${token}`,
      `export ANTHROPIC_API_KEY=${join('sk-ant-', 'api03-abcdefghijklmnop')}`,
      `OPENAI_API_KEY=${join('sk-', 'abcdefghijklmnopqrstuvwx1234')}`,
      `git push https://${join('ghp_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')}@github.com/x/y`,
      `aws key ${join('AKIA', 'ABCDEFGHIJKLMNOP')}`,
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----',
      `commit ${sha} in thread ${uuid}`,
    ].join('\n');
    const { text: out, redactions } = redactForEgress(text, [token, 'short']);
    expect(out).not.toContain(token);
    expect(out).not.toContain('sk-ant-api03');
    expect(out).not.toContain('sk-abcdefghijklmnopqrstuvwx1234');
    expect(out).not.toContain('ghp_ABCDEF');
    expect(out).not.toContain(join('AKIA', 'ABCDEFGHIJKLMNOP'));
    expect(out).not.toContain('b3BlbnNzaC1rZXktdjEAAAAA');
    expect(out).toContain(sha);
    expect(out).toContain(uuid);
    expect(redactions).toBe(7);
  });

  it('leaves clean text unchanged', () => {
    expect(redactForEgress('Fixed the race; 3 tests pass.', [])).toEqual({ text: 'Fixed the race; 3 tests pass.', redactions: 0 });
  });

  // [text, what must not survive, what must]
  const SHAPES: Array<[string, string, string]> = [
    [`git clone https://${join('gho_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab')}@github.com/x/y`, 'gho_ABCDEF', 'github.com/x/y'],
    [`GH_TOKEN=${join('ghs_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')}`, 'ghs_ABCDEF', 'GH_TOKEN='],
    [`token ${join('github_pat_', '11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGH')}`, 'github_pat_11ABC', 'token '],
    [`session=${join('eyJhbGciOiJIUzI1NiJ9', '.eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U')}`, 'dozjgNryP4J3', 'session='],
    ['curl -H "authorization: bearer abcDEF123456ghiJKL789" https://x', 'abcDEF123456', 'authorization: bearer '],
    ['BEARER abcdefghijklmnop1234', 'abcdefghijklmnop1234', 'BEARER '],
    ["curl -H 'Authorization: token 0123456789abcdef0123456789abcdef01234567' api", '0123456789abcdef', 'Authorization: token '],
    ['Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA', 'Authorization: Basic '],
    ['psql postgres://admin:s3cr3t@db.internal:5432/app', 'admin:s3cr3t', 'postgres://[REDACTED]@db.internal:5432/app'],
    ['redis://:hunter2@cache:6379', 'hunter2', 'redis://[REDACTED]@cache:6379'],
    [`HF_TOKEN=${join('hf_', 'abcdefghijklmnopqrstuvwxyzABCDEFGH')}`, 'hf_abcdefghij', 'HF_TOKEN='],
    ['export ANTHROPIC_AUTH_TOKEN=a4f3c2b1a9e8d7c6b5a4f3c2b1a9e8d7c.AbCdEfGhIjKlMnOp', 'a4f3c2b1a9e8', 'ANTHROPIC_AUTH_TOKEN='],
    ['DB_PASSWORD=supersecret', 'supersecret', 'DB_PASSWORD='],
    ['PGPASSWORD=correcthorse', 'correcthorse', 'PGPASSWORD='],
    ['{"password": "hunter2", "user": "bob"}', 'hunter2', '"user": "bob"'],
    ["password: 'p@ss w0rd'", 'p@ss w0rd', 'password: '],
    ['client_secret=Zx8kQ2mN5pR7tV9w', 'Zx8kQ2mN5pR7tV9w', 'client_secret='],
    ['api_key: abc123def456ghi', 'abc123def456ghi', 'api_key: '],
    ['headers: {"X-Api-Key": "abc123def456ghi789"}', 'abc123def456ghi789', '"X-Api-Key": '],
    ['mysql --password hunter2 -u root', 'hunter2', '-u root'],
    ['--api-key=abc123def456ghi789', 'abc123def456ghi789', '--api-key='],
    // A JSON string inside a JSON-encoded tool input.
    ['{"command":"curl -d \'{\\"password\\":\\"hunter2\\"}\' https://x"}', 'hunter2', 'https://x'],
    // An assignment inside a non-secret key's value.
    ['{"command":"export SECRET_TOKEN=abc123def456 && run"}', 'abc123def456', '&& run'],
    // A key cut before its END line takes the rest of the field.
    ['before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabcdef', 'MIIEowIBAAKCAQEA', 'before'],
  ];

  it.each(SHAPES)('redacts %s', (text, secret, kept) => {
    const out = redactForEgress(text);
    expect(out.text).not.toContain(secret);
    expect(out.text).toContain(kept);
    expect(out.redactions).toBeGreaterThan(0);
  });

  // Code and prose a judge needs, which name a secret without holding one.
  const LOOKALIKES = [
    'The token expired, so pass the API key again; use bearer authentication.',
    'const token = getToken();',
    'const apiKey = process.env.OPENAI_API_KEY;',
    'password: string;',
    'interface User { password?: string }',
    'max_tokens=4096 and tokens: 1500',
    'TOKEN_TYPE=bearer',
    'SORT_KEY=createdAt',
    'primaryKey: "id"',
    "fetch(url, { credentials: 'include' })",
    'ssh://git@github.com/x/y.git',
    'git@github.com:x/y.git',
    'https://example.com/a/b?x=1',
    'bypass=true; compass: north',
    'if (password == null) return;',
    'token = this.token',
    'PASSWORD_MIN_LENGTH=8',
    '--token-file ~/.tok --max-tokens 4096',
  ];

  it.each(LOOKALIKES)('leaves %s alone', (text) => {
    expect(redactForEgress(text)).toEqual({ text, redactions: 0 });
  });
});

describe('sampling', () => {
  const row = (taskId: string, category: string | null = 'coding', project: string | null = 'AgentDeck'): ApmeLocalVerdictRow => ({
    taskId, runId: `r-${taskId}`, agentType: 'claude-code', project, category, endedAt: 1, summary: null,
    localOverall: 1, localJudge: 'mlx:x', localRubricVer: 1, localJudgedAt: 1,
  });

  it('a task keeps its place when the pool grows, so a dry run shows what --run sends', () => {
    const pool = Array.from({ length: 40 }, (_, i) => row(`t${i}`));
    const first = pickReferenceCandidates(pool, { limit: 40, skip: new Set(), seed: 's' }).map((r) => r.taskId);
    const grown = pickReferenceCandidates([...pool, row('new-1'), row('new-2')], { limit: 42, skip: new Set(), seed: 's' })
      .map((r) => r.taskId).filter((id) => !id.startsWith('new-'));
    expect(grown).toEqual(first);
    expect(first).not.toEqual(pool.map((r) => r.taskId)); // not just newest-first
  });

  it('skips what this judge already scored, so the next run continues', () => {
    const pool = Array.from({ length: 10 }, (_, i) => row(`t${i}`));
    const firstThree = pickReferenceCandidates(pool, { limit: 3, skip: new Set(), seed: 's' }).map((r) => r.taskId);
    const next = pickReferenceCandidates(pool, { limit: 3, skip: new Set(firstThree), seed: 's' }).map((r) => r.taskId);
    expect(next.some((id) => firstThree.includes(id))).toBe(false);
    expect(next).toEqual(pickReferenceCandidates(pool, { limit: 6, skip: new Set(), seed: 's' }).map((r) => r.taskId).slice(3));
  });

  it('filters by category', () => {
    const pool = [row('a', 'ops'), row('b', 'coding'), row('c', 'ops')];
    expect(pickReferenceCandidates(pool, { limit: 5, skip: new Set(), seed: 's', category: 'ops' }).map((r) => r.taskId).sort())
      .toEqual(['a', 'c']);
  });

  it('sends only allow-listed projects, matched case-insensitively; a task with no project never passes the list', () => {
    const pool = [row('a', 'ops', 'AgentDeck'), row('b', 'ops', 'ClientWork'), row('c', 'ops', 'agentdeck'), row('d', 'ops', null)];
    const pick = (projects?: string[]) =>
      pickReferenceCandidates(pool, { limit: 10, skip: new Set(), seed: 's', projects }).map((r) => r.taskId).sort();
    expect(pick(['agentdeck'])).toEqual(['a', 'c']);
    expect(pick(['AgentDeck', 'ClientWork'])).toEqual(['a', 'b', 'c']);
    expect(pick([])).toEqual(['a', 'b', 'c', 'd']);
    expect(pick()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('filters by the local outcome band, at the task outcome thresholds', () => {
    const pool = [0, 0.49, 0.5, 0.74, 0.75, 1].map((score, i) => ({ ...row(`t${i}`), localOverall: score }));
    const band = (localBand: 'success' | 'partial' | 'fail') =>
      pickReferenceCandidates(pool, { limit: 10, skip: new Set(), seed: 's', localBand }).map((r) => r.localOverall).sort();
    expect(band('fail')).toEqual([0, 0.49]);
    expect(band('partial')).toEqual([0.5, 0.74]);
    expect(band('success')).toEqual([0.75, 1]);
  });
});

describe('agreement', () => {
  it('perfect agreement', () => {
    const s = computeAgreement([{ local: 1, reference: 1 }, { local: 0.6, reference: 0.6 }, { local: 0.1, reference: 0.1 }]);
    expect(s.mae).toBe(0);
    expect(s.bias).toBe(0);
    expect(s.spearman).toBeCloseTo(1, 10);
    expect(s.bucketAgreement).toBe(1);
    expect(s.kappa).toBeCloseTo(1, 10);
  });

  it('a lenient local judge has positive bias, and bands disagree where it passes what the reference fails', () => {
    const s = computeAgreement([
      { local: 1, reference: 0.4 },
      { local: 1, reference: 0.9 },
      { local: 0, reference: 0.2 },
      { local: 1, reference: 0.6 },
    ]);
    expect(s.n).toBe(4);
    expect(s.mae).toBeCloseTo((0.6 + 0.1 + 0.2 + 0.4) / 4, 10);
    expect(s.bias).toBeCloseTo((0.6 + 0.1 - 0.2 + 0.4) / 4, 10);
    expect(s.confusion.success).toEqual({ success: 1, partial: 1, fail: 1 });
    expect(s.confusion.fail).toEqual({ success: 0, partial: 0, fail: 1 });
    expect(s.bucketAgreement).toBe(0.5);
    // po = 0.5; local bands (3 success, 1 fail), reference (1, 1, 2): pe = 3/4·1/4 + 1/4·2/4 = 5/16.
    expect(s.kappa).toBeCloseTo((0.5 - 5 / 16) / (1 - 5 / 16), 10);
    expect(s.localExtremeShare).toBe(1);
    expect(s.referenceExtremeShare).toBe(0);
    expect(s.maeCi).toBeNull(); // below 5 pairs
  });

  it('kappa is undefined when both judges put everything in one band', () => {
    const s = computeAgreement([{ local: 1, reference: 0.9 }, { local: 0.95, reference: 1 }]);
    expect(s.kappa).toBeNull();
    expect(s.bucketAgreement).toBe(1);
  });

  it('spearman uses average ranks for ties and is undefined for a constant side', () => {
    expect(computeAgreement([{ local: 1, reference: 0.2 }, { local: 1, reference: 0.5 }, { local: 1, reference: 0.9 }]).spearman).toBeNull();
    const s = computeAgreement([{ local: 0, reference: 0.1 }, { local: 1, reference: 0.5 }, { local: 1, reference: 0.9 }]);
    expect(s.spearman).toBeCloseTo(0.8660254, 6);
  });

  it('bootstrap intervals are deterministic and bracket the point estimate', () => {
    const pairs = Array.from({ length: 20 }, (_, i) => ({ local: i % 3 === 0 ? 1 : 0.5, reference: (i % 5) / 4 }));
    const a = computeAgreement(pairs);
    const b = computeAgreement(pairs);
    expect(a.maeCi).toEqual(b.maeCi);
    expect(a.maeCi![0]).toBeLessThanOrEqual(a.mae!);
    expect(a.maeCi![1]).toBeGreaterThanOrEqual(a.mae!);
  });

  it('empty input', () => {
    expect(computeAgreement([]).mae).toBeNull();
  });
});

describe('reference verdicts in the store', () => {
  let store!: ApmeStore;
  beforeEach(async () => { store = await makeStore(); });
  afterEach(() => { cleanup(store); });

  const refRow = (o: Partial<ApmeReferenceEvalRow>): ApmeReferenceEvalRow => ({
    taskId: 't1', runId: 'r', judge: 'codex:m@high', sample: 'uniform', category: 'coding', rubricVer: 1, promptSha: 'abc',
    overall: 0.5, scoresJson: '{"overall":0.5}', verdictJson: '{"summary":"Ref says partial","missed":["tests"]}', error: null,
    localJudge: 'mlx:x', localOverall: 1, localRubricVer: 1, localJudgedAt: 1,
    inputTokens: 20_000, cachedInputTokens: 0, outputTokens: 300, reasoningTokens: 100, latencyMs: 30_000,
    createdAt: Date.now(), ...o,
  });

  function seedTask(id: string, endedAt: number, verdicts: Array<{ score: number; createdAt: number; judge?: string }>) {
    store.insertTask({ id, runId: 'r', taskIndex: 0, boundarySignal: 'open', startedAt: endedAt - 1000 });
    store.updateTask(id, { endedAt, boundarySignal: 'idle_gap', taskCategory: 'coding' });
    for (const v of verdicts) {
      store.insertEvalForTask({ id: 0, runId: 'r', taskId: id, layer: 'task_judge', metric: 'overall', score: v.score, raw: null, rubricVer: 7, judgeModel: v.judge ?? 'mlx:old', createdAt: v.createdAt });
      store.insertEvalForTask({ id: 0, runId: 'r', taskId: id, layer: 'task_judge', metric: 'completion', score: 0.1, raw: null, rubricVer: 7, judgeModel: v.judge ?? 'mlx:old', createdAt: v.createdAt });
    }
  }

  it('offers closed tasks with their latest local overall verdict, newest first', () => {
    const now = Date.now();
    store.insertRun({ id: 'r', sessionId: 's', agentType: 'codex-cli', projectName: 'AgentDeck', startedAt: now - 100_000 });
    seedTask('judged-twice', now - 1000, [{ score: 0.2, createdAt: now - 900 }, { score: 1, createdAt: now - 800, judge: 'mlx:new' }]);
    seedTask('older', now - 5000, [{ score: 0, createdAt: now - 4000 }]);
    seedTask('unjudged', now - 2000, []);
    seedTask('ancient', now - 40 * 86_400_000, [{ score: 1, createdAt: now - 40 * 86_400_000 }]);

    const rows = store.listLocallyJudgedTasks({ sinceMs: now - 30 * 86_400_000, limit: 10 });
    expect(rows.map((r) => r.taskId)).toEqual(['judged-twice', 'older']);
    expect(rows[0]).toMatchObject({
      localOverall: 1, localJudge: 'mlx:new', localRubricVer: 7, agentType: 'codex-cli', project: 'AgentDeck', category: 'coding',
    });
  });

  it('stores attempts apart from evals; only successful verdicts count as scored', () => {
    const now = Date.now();
    store.insertRun({ id: 'r', sessionId: 's', agentType: 'claude-code', startedAt: now });
    store.insertTask({ id: 't1', runId: 'r', taskIndex: 0, boundarySignal: 'open', startedAt: now });
    store.insertTask({ id: 't2', runId: 'r', taskIndex: 1, boundarySignal: 'open', startedAt: now });
    store.insertReferenceEval(refRow({ taskId: 't1' }));
    store.insertReferenceEval(refRow({ taskId: 't2', overall: null, scoresJson: null, verdictJson: null, error: 'timed out after 300 s' }));
    store.insertReferenceEval(refRow({ taskId: 't2', sample: 'local_band=fail' }));

    expect([...store.referenceVerdictTaskIds('codex:m@high', 'uniform')]).toEqual(['t1']);
    // A verdict made for another design leaves the task in this design's sample.
    expect([...store.referenceVerdictTaskIds('codex:m@high', 'local_band=fail')]).toEqual(['t2']);
    expect(store.referenceVerdictTaskIds('codex:other@high', 'uniform').size).toBe(0);
    expect(store.listReferenceEvals()).toHaveLength(3);
    expect(store.listReferenceEvals({ judge: 'codex:other@high' })).toHaveLength(0);
    expect(store.listReferenceEvals({ sample: 'local_band=fail' })).toHaveLength(1);
    expect(store.listReferenceEvals({ sample: 'uniform' })[0]).toMatchObject({ taskId: 't1', sample: 'uniform' });
    // The product's own verdict tables never see a reference verdict.
    expect(store.listEvalsForTask('t1')).toEqual([]);
    expect(store.getTask('t1')!.compositeScore).toBeNull();
  });

  it('reports count a re-scored task once, by its latest verdict, and rank disagreements by size', () => {
    const t0 = 1_000_000;
    const rows: ApmeReferenceEvalRow[] = [
      refRow({ id: 1, taskId: 'a', overall: 0.2, localOverall: 1, createdAt: t0 }),
      refRow({ id: 2, taskId: 'a', overall: 0.9, localOverall: 1, createdAt: t0 + 10 }),
      refRow({ id: 3, taskId: 'b', overall: 0.3, localOverall: 0.9, createdAt: t0 + 20, category: 'ops' }),
      refRow({ id: 4, taskId: 'c', overall: null, error: 'timed out after 300 s', createdAt: t0 + 30 }),
      refRow({ id: 5, taskId: 'a', judge: 'codex:other@low', overall: 0.5, localOverall: 1, createdAt: t0 + 40 }),
    ];
    const [main, other] = buildReferenceReports(rows, { top: 5, localSummary: (id) => `local ${id}` });
    expect(main.judge).toBe('codex:m@high');
    expect(main.attempts).toBe(4);
    expect(main.failures).toBe(1);
    expect(main.failureReasons).toEqual([{ reason: 'timed out after 300 s', count: 1 }]);
    expect(main.stats.n).toBe(2);
    expect(main.disagreements.map((d) => [d.taskId, Number(d.delta.toFixed(2))])).toEqual([['b', 0.6], ['a', 0.1]]);
    expect(main.disagreements[0]).toMatchObject({ localSummary: 'local b', referenceSummary: 'Ref says partial', referenceMissed: ['tests'] });
    expect(main.byCategory.map((g) => g.key).sort()).toEqual(['coding', 'ops']);
    expect(other).toMatchObject({ judge: 'codex:other@low', attempts: 1 });
  });

  it('keeps sampling designs apart: a band-targeted sample is not pooled into the uniform estimate', () => {
    const rows = [
      refRow({ id: 1, taskId: 'u1', overall: 0.9, localOverall: 1 }),
      refRow({ id: 2, taskId: 'f1', sample: 'local_band=fail', overall: 0.95, localOverall: 0 }),
      refRow({ id: 3, taskId: 'f2', sample: 'local_band=fail', overall: 0.2, localOverall: 0 }),
    ];
    const reports = buildReferenceReports(rows, { top: 0 });
    expect(reports.map((r) => [r.sample, r.stats.n])).toEqual([['uniform', 1], ['local_band=fail', 2]]);
    expect(reports[1].stats.confusion.fail).toEqual({ success: 1, partial: 0, fail: 1 });
  });

  it('reads the pool as it stood at untilMs: a task judged after it cannot enter', () => {
    const until = Date.now() - 60_000;
    store.insertRun({ id: 'r', sessionId: 's', agentType: 'codex-cli', projectName: 'AgentDeck', startedAt: until - 100_000 });
    seedTask('before', until - 5000, [{ score: 0.4, createdAt: until - 4000 }]);
    seedTask('judged-after', until - 3000, [{ score: 1, createdAt: until + 1000 }]);
    seedTask('rejudged', until - 2000, [{ score: 0.1, createdAt: until - 1500 }, { score: 0.9, createdAt: until + 2000, judge: 'mlx:new' }]);
    seedTask('closed-after', until + 500, [{ score: 1, createdAt: until + 600 }]);

    const asOf = store.listLocallyJudgedTasks({ sinceMs: until - 86_400_000, untilMs: until, limit: 10 });
    expect(asOf.map((r) => r.taskId)).toEqual(['rejudged', 'before']);
    // A task re-judged since carries the verdict it had then.
    expect(asOf[0]).toMatchObject({ localOverall: 0.1, localJudge: 'mlx:old' });
    expect(store.listLocallyJudgedTasks({ sinceMs: until - 86_400_000, limit: 10 }).map((r) => r.taskId))
      .toEqual(['closed-after', 'rejudged', 'judged-after', 'before']);
  });

  it('a plan made at untilMs picks the same list after later activity, and names what to drop', () => {
    const until = Date.now() - 60_000;
    store.insertRun({ id: 'r', sessionId: 's', agentType: 'codex-cli', projectName: 'AgentDeck', startedAt: until - 100_000 });
    for (let i = 0; i < 6; i++) seedTask(`t${i}`, until - 10_000 + i * 100, [{ score: i % 2, createdAt: until - 5000 + i * 100 }]);
    const opts = { judge: 'codex:m@high', sample: 'uniform', untilMs: until, windowMs: 86_400_000, limit: 3, seed: 's', projects: [] };
    const dry = planReferenceRun(store, opts);
    expect(dry.picks).toHaveLength(3);

    // Between the dry run and the run: a task closes and is judged, a pick is
    // re-judged, and an earlier run of the same command scores another.
    seedTask('late', until + 100, [{ score: 1, createdAt: until + 200 }]);
    store.insertEvalForTask({ id: 0, runId: 'r', taskId: dry.picks[0].taskId, layer: 'task_judge', metric: 'overall', score: 0.5, raw: null, rubricVer: 8, judgeModel: 'mlx:new', createdAt: until + 300 });
    store.insertReferenceEval(refRow({ taskId: dry.picks[1].taskId, createdAt: until + 400 }));

    const run = planReferenceRun(store, opts);
    expect(run.picks.map((p) => p.taskId)).toEqual(dry.picks.map((p) => p.taskId));
    expect(run.digest).toBe(dry.digest);
    expect(run.picks[0].localOverall).toBe(dry.picks[0].localOverall);
    expect([...handledSince(store, run, opts)]).toEqual([dry.picks[1].taskId]);
    // Read as of now, the scored pick is gone and the list changes.
    expect(planReferenceRun(store, { ...opts, untilMs: Date.now() }).digest).not.toBe(dry.digest);
  });

  it('parks a task after two failed attempts in one design, and --retry-parked sends it again', () => {
    const t0 = Date.now() - 60_000;
    store.insertRun({ id: 'r', sessionId: 's', agentType: 'codex-cli', projectName: 'AgentDeck', startedAt: t0 - 100_000 });
    for (const id of ['a', 'b', 'c']) seedTask(id, t0 - 10_000, [{ score: 1, createdAt: t0 - 9000 }]);
    const failed = (taskId: string, createdAt: number, sample = 'uniform') => refRow({ taskId, sample, overall: null, scoresJson: null, verdictJson: null, error: 'timed out after 300 s', createdAt });
    store.insertReferenceEval(failed('a', t0));
    store.insertReferenceEval(failed('a', t0 + 1000));
    store.insertReferenceEval(failed('b', t0));
    store.insertReferenceEval(failed('b', t0, 'local_band=success'));
    store.insertReferenceEval(failed('c', t0));
    store.insertReferenceEval(failed('c', t0 + 1000));
    store.insertReferenceEval(refRow({ taskId: 'c', createdAt: t0 + 2000 }));

    expect(store.referenceFailureCounts('codex:m@high', 'uniform')).toEqual(new Map([['a', 2], ['b', 1], ['c', 2]]));
    expect(store.referenceFailureCounts('codex:m@high', 'uniform', t0 + 500).get('a')).toBe(1);
    expect(store.referenceFailureCounts('codex:other@high', 'uniform').size).toBe(0);
    // A task that failed twice and then got a verdict is scored, not parked.
    expect([...parkedReferenceTasks(store.referenceFailureCounts('codex:m@high', 'uniform'), store.referenceVerdictTaskIds('codex:m@high', 'uniform'))]).toEqual(['a']);

    const opts = { judge: 'codex:m@high', sample: 'uniform', untilMs: Date.now(), windowMs: 86_400_000, limit: 10, seed: 's', projects: [] };
    const plan = planReferenceRun(store, opts);
    expect([...plan.parked]).toEqual(['a']);
    expect(plan.picks.map((p) => p.taskId)).toEqual(['b']);
    expect(planReferenceRun(store, { ...opts, retryParked: true }).picks.map((p) => p.taskId).sort()).toEqual(['a', 'b']);
    // Parked as of the dry run's time only: a second failure since is dropped by the run.
    const early = planReferenceRun(store, { ...opts, untilMs: t0 + 500 });
    expect(early.picks.map((p) => p.taskId).sort()).toEqual(['a', 'b', 'c']);
    expect([...handledSince(store, early, opts)].sort()).toEqual(['a', 'c']);
  });

  it('labels the design from the filters it was drawn under', () => {
    expect(referenceSampleLabel({})).toBe('uniform');
    expect(referenceSampleLabel({ localBand: 'fail' })).toBe('local_band=fail');
    expect(referenceSampleLabel({ category: 'ops', localBand: 'fail' })).toBe('category=ops,local_band=fail');
    // One design however the list is spelled or ordered.
    expect(referenceSampleLabel({ projects: ['Remin', 'AgentDeck', 'agentdeck'] })).toBe('project=agentdeck|remin');
    expect(referenceSampleLabel({ projects: [] })).toBe('uniform');
  });
});
