import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SECURITY_FRESHNESS = {
  'security-scan.yml': { hours: 26, name: 'Dependency scans' },
  'codeql.yml': { hours: 24 * 8, name: 'CodeQL' },
};

/** A manual/push success never supplies evidence that cron itself ran. */
export function workflowHealth(workflow, runs, scheduled, now = Date.now(), currentRunId = 0) {
  const age = (value) => {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp) || timestamp > now) throw new Error('Invalid workflow timestamp');
    return now - timestamp;
  };
  const policy = SECURITY_FRESHNESS[workflow.path.split('/').at(-1)];
  if (!policy || !Array.isArray(runs) || !Array.isArray(scheduled)) throw new Error('Invalid workflow inventory');
  const messages = [];
  let status = 'healthy';
  const fail = (message) => { status = 'failed'; messages.push(message); };
  if (workflow.state !== 'active') fail('Workflow is not active');
  const prior = runs.filter(r => r.id !== currentRunId);
  const latest = prior[0];
  const completed = prior.find(r => r.status === 'completed' && r.conclusion !== 'cancelled');
  const limit = policy.hours * 3_600_000;
  if (!completed || completed.conclusion !== 'success') fail('No successful latest completed scan');
  else if (age(completed.updated_at) > limit) fail('Latest scan is overdue');
  if (latest && latest.status !== 'completed' && age(latest.created_at) > 90 * 60_000) fail('Scan has been pending for over 90 minutes');
  const lastScheduled = scheduled.find(r => r.id !== currentRunId && r.status === 'completed' && r.conclusion !== 'cancelled');
  if (!lastScheduled) {
    if (age(workflow.created_at) > limit) fail('No scheduled execution within the startup deadline');
    else {
      if (status !== 'failed') status = 'unverified';
      messages.push('First scheduled execution is unverified during the bounded startup window');
    }
  } else if (lastScheduled.conclusion !== 'success' || age(lastScheduled.updated_at) > limit) {
    fail('Scheduled execution failed or is overdue');
  }
  return { name: policy.name, status, messages, latest: completed?.html_url ?? null,
    lastScheduled: lastScheduled?.html_url ?? null, maximumAgeHours: policy.hours };
}

export async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository ?? '')) throw new Error('GITHUB_REPOSITORY is required');
  const get = async (path) => {
    const response = await fetch(`https://api.github.com/repos/${repository}${path ? `/${path}` : ''}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'AgentDeck-security-health',
        ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) },
      signal: AbortSignal.timeout(15_000), redirect: 'error',
    });
    if (!response.ok) throw new Error(`GitHub evidence unavailable: HTTP ${response.status}`);
    return response.json();
  };
  const repo = await get('');
  if (typeof repo.default_branch !== 'string') throw new Error('Missing default branch');
  const branch = encodeURIComponent(repo.default_branch);
  const results = await Promise.all(Object.keys(SECURITY_FRESHNESS).map(async (file) => {
    const base = `actions/workflows/${file}`;
    const [workflow, runs, scheduled] = await Promise.all([
      get(base), get(`${base}/runs?branch=${branch}&per_page=10`),
      get(`${base}/runs?branch=${branch}&event=schedule&per_page=5`),
    ]);
    if (!Array.isArray(runs.workflow_runs) || !Array.isArray(scheduled.workflow_runs)) throw new Error('Incomplete run inventory');
    return workflowHealth(workflow, runs.workflow_runs, scheduled.workflow_runs, Date.now(), Number(process.env.GITHUB_RUN_ID ?? 0));
  }));
  const directory = resolve(process.argv[2] ?? 'diagnostics/security-health');
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, 'receipt.json'), JSON.stringify({ capturedAt: new Date().toISOString(), repository, results }, null, 2) + '\n');
  const summary = ['# Security pipeline freshness', '', '| Pipeline | State | Latest scan | Last scheduled run |', '|---|---|---|---|',
    ...results.map(r => `| ${r.name} | ${r.status} | ${r.latest ? `[run](${r.latest})` : 'unknown'} | ${r.lastScheduled ? `[run](${r.lastScheduled})` : 'unverified'} |`),
    '', ...results.flatMap(r => r.messages.map(m => `- ${r.name}: ${m}`))].join('\n') + '\n';
  writeFileSync(resolve(directory, 'summary.md'), summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  for (const r of results) {
    console.log(`${r.name}: ${r.status}`);
    for (const message of r.messages) console.log(`::${r.status === 'failed' ? 'error' : 'warning'}::${r.name}: ${message}`);
  }
  if (results.some(r => r.status === 'failed')) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Security freshness check failed: ${error.message}`); process.exitCode = 1; });
}
