#!/usr/bin/env node
/**
 * Latest completed run of every workflow the verification catalog names, for
 * the Build Health page (scripts/generate-html-report.py reads the output).
 *
 * The Pages job re-runs Vitest, E2E and Android itself; Apple XCTest, the
 * macOS/Windows runtime jobs, the ESP32 compile and the release workflows run
 * elsewhere, and before this the page could only say "not run here" about
 * them. This records what those workflows last concluded, on which commit, so
 * the page can link the evidence without ever counting it as its own.
 *
 * Fail-soft by design: a rate limit or a missing token writes an empty map and
 * exits 0. The page then claims nothing about those workflows, which is the
 * honest fallback; taking the whole Pages deploy down for it would not be.
 *
 *   GH_TOKEN=… node scripts/fetch-workflow-status.mjs --out coverage/test-report/workflow-status.json
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const out = resolve(root, outIndex >= 0 ? args[outIndex + 1] : 'coverage/test-report/workflow-status.json');
const repo = process.env.GITHUB_REPOSITORY || 'puritysb/AgentDeck';
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

const catalog = JSON.parse(readFileSync(resolve(root, 'scripts/verification-catalog.json'), 'utf8'));
const workflows = [...new Set(catalog.gates.map((g) => g.workflow).filter(Boolean))];

async function latestRun(workflow, query) {
  const file = workflow.split('/').pop();
  // No status= filter: combined with branch= the API answers from a stale
  // index (measured 2026-10-07: ci.yml on master came back as 2026-09-01 while
  // master had run that day), so filter the newest page here instead.
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${file}/runs?per_page=20${query}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  return (await res.json()).workflow_runs?.find((run) => run.status === 'completed') ?? null;
}

const result = { fetched_at: new Date().toISOString(), repository: repo, workflows: {} };
for (const workflow of workflows) {
  try {
    // Master first; PR-only workflows (ESP32 compile) and tag-only release
    // workflows have no master run, so fall back to the latest completed run
    // and say which branch or tag it was.
    let scope = 'master';
    let run = await latestRun(workflow, '&branch=master');
    if (!run) {
      scope = 'latest';
      run = await latestRun(workflow, '');
    }
    if (!run) continue;
    result.workflows[workflow] = {
      scope,
      name: run.name,
      conclusion: run.conclusion,
      event: run.event,
      head_branch: run.head_branch,
      head_sha: run.head_sha,
      created_at: run.run_started_at || run.created_at,
      html_url: run.html_url,
    };
  } catch (err) {
    console.warn(`fetch-workflow-status: ${err.message}`);
  }
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
console.log(`fetch-workflow-status: ${Object.keys(result.workflows).length}/${workflows.length} workflows → ${out}`);
