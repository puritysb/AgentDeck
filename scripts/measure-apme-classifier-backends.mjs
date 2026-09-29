#!/usr/bin/env node
// Live inference measurement harness for issue #299's classifier item.
//
// Reads REAL task prompts + signals out of the maintainer's own
// `~/.agentdeck/apme.sqlite` (opened `readonly: true, fileMustExist: true` —
// better-sqlite3 refuses a write statement against that handle, and this
// script issues none) and asks each available local classification backend
// for a category with the SAME short prompt the production classifier uses
// (`shared/src/apme-classifier-rules.ts`): rules, MLX (resident verified), and Apple Foundation Models (via the bundled Node helper,
// `bridge/src/foundation-models-helper.ts`). It never writes to the DB and
// never mutates `runs`/`tasks`/`turns`.
//
// Inference consumes GPU memory. Use a dedicated endpoint for experiments;
// this harness refuses model replacement and stops at the first MLX failure.
// This is a manual diagnostic, not a CI gate — the sample depends on
// whatever real history exists on the machine running it, and the DB path
// only reliably exists on a maintainer's own Mac. Run it by hand:
//
//   node scripts/measure-apme-classifier-backends.mjs [--limit=40] [--db=<path>]
//
// Output: an agreement matrix (FM vs rules, MLX vs rules, FM vs MLX),
// latency percentiles per backend, and the out-of-vocabulary ("invalid
// label") rate per backend. The numbers this run produced on 2026-09-10 are
// recorded in docs/apme.md and are what `APME_CLASSIFIER_BACKEND_ORDER` in
// shared/src/apme-classifier-rules.ts is pinned against — re-run this and
// update both places together if the on-device model materially improves.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(projectDir, 'bridge', 'package.json'));

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);

const LIMIT = Number(args.limit ?? 40);
const dbPath = args.db ?? path.join(process.env.AGENTDECK_DATA_DIR || path.join(homedir(), '.agentdeck'), 'apme.sqlite');

const {
  APME_CLASSIFIER_SYSTEM_PROMPT,
  APME_CLASSIFIER_MAX_TOKENS,
  APME_CLASSIFIER_TIMEOUT_MS,
  buildClassifierUserMessage,
  normalizeClassifierLabel,
} = await import(path.join(projectDir, 'shared', 'dist', 'apme-classifier-rules.js'));

const { classify } = await import(path.join(projectDir, 'bridge', 'dist', 'apme', 'classifier.js'));
const { callFoundationModelsHelper, probeFoundationModelsHelper } =
  await import(path.join(projectDir, 'bridge', 'dist', 'foundation-models-helper.js'));

function openReadOnlyDb(file) {
  const Database = require('better-sqlite3');
  return new Database(file, { readonly: true, fileMustExist: true });
}

function toolSummaryFrom(signals) {
  const counts = signals.toolCounts ?? {};
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([t, c]) => `${t}×${c}`)
    .join(', ');
}

function userMessageFor(taskPrompt, signals) {
  return buildClassifierUserMessage({
    taskPrompt: taskPrompt.slice(0, 500),
    toolSummary: toolSummaryFrom(signals),
    totalToolCalls: signals.totalToolCalls ?? 0,
    filesModified: signals.filesModified ?? 0,
    filesCreated: signals.filesCreated ?? 0,
    sessionDurationSec: signals.sessionDurationSec ?? 0,
    turnCount: signals.turnCount ?? 0,
  });
}

// ─── Sample selection ────────────────────────────────────────────────────────

function sampleRows(db, limit) {
  const rows = db
    .prepare(
      `SELECT id, task_prompt, task_signals FROM runs
       WHERE task_prompt IS NOT NULL AND length(trim(task_prompt)) >= 5
         AND task_signals IS NOT NULL
       ORDER BY started_at DESC
       LIMIT 4000`,
    )
    .all();

  const buckets = new Map(); // category -> rows
  for (const row of rows) {
    let signals;
    try {
      signals = JSON.parse(row.task_signals);
    } catch {
      continue;
    }
    const category = classify(signals);
    if (!buckets.has(category)) buckets.set(category, []);
    buckets.get(category).push({ id: row.id, taskPrompt: row.task_prompt, signals, ruleCategory: category });
  }

  const categories = [...buckets.keys()];
  const perCategory = Math.max(1, Math.ceil(limit / Math.max(1, categories.length)));
  const sampled = [];
  for (const cat of categories) {
    const bucket = buckets.get(cat);
    // Deterministic-ish spread: take evenly spaced indices rather than the
    // first N, so a category whose rows are dominated by one repeated
    // automated prompt doesn't drown out the rest of that bucket.
    const step = Math.max(1, Math.floor(bucket.length / perCategory));
    for (let i = 0; i < bucket.length && sampled.length < limit && sampled.filter((r) => r.ruleCategory === cat).length < perCategory; i += step) {
      sampled.push(bucket[i]);
    }
  }
  return { sampled: sampled.slice(0, limit), bucketSizes: Object.fromEntries(categories.map((c) => [c, buckets.get(c).length])) };
}

// ─── MLX backend ─────────────────────────────────────────────────────────────

const { loadMlxSettings, mlxBaseUrl, resolveSafeMlxModel, guardedMlxFetch } =
  await import(path.join(projectDir, 'shared', 'dist', 'index.js'));
const mlxSettings = loadMlxSettings();
const MLX_BASE = mlxBaseUrl(args.endpoint ?? mlxSettings.endpoint);
const requestedModel = args.model ?? mlxSettings.model;

async function resolveMlxModel() {
  // Read-only preflight. Never pick a download or switch an operating server.
  return resolveSafeMlxModel(MLX_BASE, requestedModel);
}

async function classifyWithMlx(model, userMsg) {
  const start = performance.now();
  try {
    const resp = await guardedMlxFetch(`${MLX_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: APME_CLASSIFIER_SYSTEM_PROMPT },
          { role: 'user', content: userMsg },
        ],
        temperature: 0,
        max_tokens: APME_CLASSIFIER_MAX_TOKENS,
      }),
      signal: AbortSignal.timeout(APME_CLASSIFIER_TIMEOUT_MS),
    });
    const latencyMs = performance.now() - start;
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}`, latencyMs };
    const json = await resp.json();
    const raw = json.choices?.[0]?.message?.content?.trim() ?? '';
    return { ok: true, raw, label: normalizeClassifierLabel(raw), latencyMs };
  } catch (err) {
    return { ok: false, error: String(err), latencyMs: performance.now() - start };
  }
}

// ─── Foundation Models backend ───────────────────────────────────────────────

async function classifyWithFoundationModels(userMsg) {
  const start = performance.now();
  try {
    const raw = await callFoundationModelsHelper(userMsg, APME_CLASSIFIER_SYSTEM_PROMPT, {
      maxTokens: APME_CLASSIFIER_MAX_TOKENS,
      timeoutMs: APME_CLASSIFIER_TIMEOUT_MS,
    });
    const latencyMs = performance.now() - start;
    return { ok: true, raw, label: normalizeClassifierLabel(raw), latencyMs };
  } catch (err) {
    return { ok: false, error: String(err), latencyMs: performance.now() - start };
  }
}

// ─── Stats ───────────────────────────────────────────────────────────────────

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function summarizeLatency(values) {
  if (values.length === 0) return { n: 0, avgMs: null, p50Ms: null, p95Ms: null };
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return {
    n: values.length,
    avgMs: Math.round(avg),
    p50Ms: Math.round(percentile(values, 50)),
    p95Ms: Math.round(percentile(values, 95)),
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[measure] opening ${dbPath} read-only`);
  const db = openReadOnlyDb(dbPath);
  const { sampled, bucketSizes } = sampleRows(db, LIMIT);
  db.close();
  console.log(`[measure] rule-category population in this DB:`, bucketSizes);
  console.log(`[measure] sampled ${sampled.length} tasks`);

  const mlxModel = await resolveMlxModel();
  const mlxAvailable = Boolean(mlxModel);
  console.log(`[measure] MLX: ${mlxAvailable ? `reachable, model=${mlxModel}` : 'not reachable'}`);

  const fmProbe = await probeFoundationModelsHelper();
  console.log(`[measure] Foundation Models helper: ${JSON.stringify(fmProbe)}`);

  const results = [];
  for (const row of sampled) {
    const userMsg = userMessageFor(row.taskPrompt, row.signals);
    const mlx = mlxAvailable ? await classifyWithMlx(mlxModel, userMsg) : { ok: false, error: 'mlx not reachable', latencyMs: 0 };
    if (mlxAvailable && !mlx.ok) throw new Error(`MLX measurement stopped after failed inference: ${mlx.error}`);
    const fm = fmProbe.available ? await classifyWithFoundationModels(userMsg) : { ok: false, error: fmProbe.reason ?? 'unavailable', latencyMs: 0 };
    results.push({ id: row.id, ruleCategory: row.ruleCategory, mlx, fm });
    process.stdout.write('.');
  }
  process.stdout.write('\n');

  // ── Agreement matrix ──
  let fmVsRuleAgree = 0, fmVsRuleTotal = 0;
  let mlxVsRuleAgree = 0, mlxVsRuleTotal = 0;
  let fmVsMlxAgree = 0, fmVsMlxTotal = 0;
  let fmInvalid = 0, fmOkTotal = 0, fmErrors = 0;
  let mlxInvalid = 0, mlxOkTotal = 0, mlxErrors = 0;
  const mlxLatencies = [];
  const fmLatencies = [];

  for (const r of results) {
    if (r.mlx.ok) {
      mlxOkTotal++;
      mlxLatencies.push(r.mlx.latencyMs);
      if (r.mlx.label == null) mlxInvalid++;
      else {
        mlxVsRuleTotal++;
        if (r.mlx.label === r.ruleCategory) mlxVsRuleAgree++;
      }
    } else {
      mlxErrors++;
    }
    if (r.fm.ok) {
      fmOkTotal++;
      fmLatencies.push(r.fm.latencyMs);
      if (r.fm.label == null) fmInvalid++;
      else {
        fmVsRuleTotal++;
        if (r.fm.label === r.ruleCategory) fmVsRuleAgree++;
      }
    } else {
      fmErrors++;
    }
    if (r.mlx.ok && r.fm.ok && r.mlx.label != null && r.fm.label != null) {
      fmVsMlxTotal++;
      if (r.mlx.label === r.fm.label) fmVsMlxAgree++;
    }
  }

  const pct = (a, b) => (b === 0 ? 'n/a' : `${((a / b) * 100).toFixed(1)}%`);

  console.log('\n=== Agreement matrix (label match rate) ===');
  console.log(`MLX vs rules:  ${mlxVsRuleAgree}/${mlxVsRuleTotal} = ${pct(mlxVsRuleAgree, mlxVsRuleTotal)}`);
  console.log(`FM  vs rules:  ${fmVsRuleAgree}/${fmVsRuleTotal} = ${pct(fmVsRuleAgree, fmVsRuleTotal)}`);
  console.log(`FM  vs MLX:    ${fmVsMlxAgree}/${fmVsMlxTotal} = ${pct(fmVsMlxAgree, fmVsMlxTotal)}`);

  console.log('\n=== Invalid label rate (HTTP/helper OK, response not in vocabulary) ===');
  console.log(`MLX: ${mlxInvalid}/${mlxOkTotal} = ${pct(mlxInvalid, mlxOkTotal)}  (errors: ${mlxErrors}/${results.length})`);
  console.log(`FM:  ${fmInvalid}/${fmOkTotal} = ${pct(fmInvalid, fmOkTotal)}  (errors: ${fmErrors}/${results.length})`);

  console.log('\n=== Latency (successful calls only) ===');
  console.log('MLX:', summarizeLatency(mlxLatencies));
  console.log('FM: ', summarizeLatency(fmLatencies));

  const os = await import('node:os');
  const outFile = args.out ?? path.join(os.tmpdir(), 'apme-classifier-measurement.json');
  const fs = await import('node:fs');
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        dbPath,
        sampleSize: results.length,
        bucketSizes,
        mlxModel,
        fmProbe,
        results,
        summary: {
          mlxVsRule: { agree: mlxVsRuleAgree, total: mlxVsRuleTotal },
          fmVsRule: { agree: fmVsRuleAgree, total: fmVsRuleTotal },
          fmVsMlx: { agree: fmVsMlxAgree, total: fmVsMlxTotal },
          mlxInvalid: { count: mlxInvalid, of: mlxOkTotal },
          fmInvalid: { count: fmInvalid, of: fmOkTotal },
          mlxErrors,
          fmErrors,
          mlxLatency: summarizeLatency(mlxLatencies),
          fmLatency: summarizeLatency(fmLatencies),
        },
      },
      null,
      2,
    ),
  );
  console.log(`\n[measure] wrote raw results to ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
