import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CiWaitStatus } from '@agentdeck/shared';
const execute = promisify(execFile);

/** Only explicit command identity is queried. Never discover a repo by shared
 * cwd, forward credentials, spawn a shell, or mistake a failed probe for red CI. */
export function ciWaitProbePath(wait: CiWaitStatus): string | null {
  if (!wait.repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(wait.repo) ||
      wait.repo.split('/').some(p => p === '.' || p === '..')) return null;
  if (wait.runId && Number.isSafeInteger(wait.runId) && wait.runId > 0) return `repos/${wait.repo}/actions/runs/${wait.runId}`;
  // PR identity first resolves its exact head SHA; branches are not merged
  // across repos/sessions and are URL-encoded rather than treated as argv.
  if (wait.pr && Number.isSafeInteger(wait.pr) && wait.pr > 0) return `repos/${wait.repo}/pulls/${wait.pr}`;
  if (wait.ref && /^[A-Za-z0-9_./-]+$/.test(wait.ref)) return `repos/${wait.repo}/commits/${encodeURIComponent(wait.ref)}`;
  return null;
}

export function ciPhaseFromResponse(value: unknown): CiWaitStatus['phase'] {
  if (!value || typeof value !== 'object') return 'unknown';
  const data = value as Record<string, unknown>;
  if (Array.isArray(data.check_runs)) {
    // Truncated check lists cannot prove all passed.
    if (!data.check_runs.length || data.total_count !== data.check_runs.length) return 'unknown';
    const phases = data.check_runs.map(ciPhaseFromResponse);
    if (phases.includes('unknown')) return 'unknown';
    if (phases.includes('running')) return 'running';
    if (phases.includes('queued')) return 'queued';
    if (phases.includes('failed')) return 'failed';
    return phases.every(p => p === 'passed') ? 'passed' : 'unknown';
  }
  if (data.status === 'in_progress') return 'running';
  if (['queued', 'waiting', 'pending', 'requested'].includes(String(data.status))) return 'queued';
  if (data.status !== 'completed') return 'unknown';
  if (data.conclusion === 'success') return 'passed';
  if (['failure', 'timed_out', 'action_required', 'startup_failure'].includes(String(data.conclusion))) return 'failed';
  // Cancellation, skipped and neutral are not successful validation.
  return 'unknown';
}

/** Check runs and legacy commit statuses both participate in gh pr checks.
 * Empty lists are neutral only when the other source has real evidence. */
export function ciPhaseFromCommit(checks: Record<string, unknown>, statuses: Record<string, unknown>): CiWaitStatus['phase'] {
  const phases: CiWaitStatus['phase'][] = [];
  if (!Array.isArray(checks.check_runs) || checks.total_count !== checks.check_runs.length ||
      !Array.isArray(statuses.statuses) || statuses.total_count !== statuses.statuses.length) return 'unknown';
  if (checks.check_runs.length) phases.push(ciPhaseFromResponse(checks));
  if (statuses.statuses.length) {
    phases.push(statuses.state === 'success' ? 'passed' : statuses.state === 'failure' ? 'failed' :
      statuses.state === 'pending' ? 'queued' : 'unknown');
  }
  if (!phases.length || phases.includes('unknown')) return 'unknown';
  if (phases.includes('running')) return 'running';
  if (phases.includes('queued')) return 'queued';
  return phases.includes('failed') ? 'failed' : 'passed';
}

export async function probeCiWait(wait: CiWaitStatus): Promise<Pick<CiWaitStatus, 'phase' | 'checks' | 'runUrl'>> {
  const path = ciWaitProbePath(wait);
  if (!path) return { phase: 'unknown' };
  const get = async (endpoint: string) => {
    const { stdout } = await execute('gh', ['api', '--hostname', 'github.com', endpoint], {
      timeout: 8_000, maxBuffer: 256 * 1024, windowsHide: true,
      env: { ...process.env, GH_PROMPT_DISABLED: '1' },
    });
    return JSON.parse(stdout) as Record<string, unknown>;
  };
  try {
    const response = await get(path);
    if (wait.runId) return { phase: ciPhaseFromResponse(response), runUrl: githubRunUrl(response.html_url) };
    const sha = wait.pr ? (response.head as { sha?: unknown } | undefined)?.sha : response.sha;
    if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha)) return { phase: 'unknown' };
    const [checks, statuses] = await Promise.all([
      get(`repos/${wait.repo}/commits/${sha}/check-runs`),
      get(`repos/${wait.repo}/commits/${sha}/status`),
    ]);
    return { phase: ciPhaseFromCommit(checks, statuses), checks: ciCheckCounts(checks, statuses), runUrl: githubRunUrl(response.html_url) };
  } catch { return { phase: 'unknown' }; }
}

function githubRunUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password ? url.href : undefined; }
  catch { return undefined; }
}
export function ciCheckCounts(checks: Record<string, unknown>, statuses: Record<string, unknown>): CiWaitStatus['checks'] {
  if (!Array.isArray(checks.check_runs) || checks.total_count !== checks.check_runs.length ||
      !Array.isArray(statuses.statuses) || statuses.total_count !== statuses.statuses.length) return undefined;
  const phases = checks.check_runs.map(ciPhaseFromResponse);
  for (const row of statuses.statuses) {
    const state = row?.state;
    phases.push(state === 'success' ? 'passed' : state === 'failure' ? 'failed' : state === 'pending' ? 'queued' : 'unknown');
  }
  if (!phases.length || phases.includes('unknown')) return undefined;
  return { total: phases.length, passed: phases.filter(p => p === 'passed').length,
    failed: phases.filter(p => p === 'failed').length, pending: phases.filter(p => p === 'queued' || p === 'running').length };
}
