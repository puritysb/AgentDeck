import { describe, expect, it } from 'vitest';
import { ciCheckCounts, ciPhaseFromCommit, ciPhaseFromResponse, ciWaitProbePath } from '../ci-wait-probe.js';
import { activityFor } from '../session-activity.js';
import type { CiWaitStatus } from '@agentdeck/shared';
const wait: CiWaitStatus = { kind: 'ci', provider: 'github-actions', phase: 'unknown', agentWaiting: true, evidence: 'tool_input', openedAt: 1 };
describe('CI wait provider evidence', () => {
  it('keeps canonical CI activity ahead of a stale tool or FM summary', () => {
    expect(activityFor({ id: 'ci', port: 0, alive: true, projectName: 'demo', state: 'idle', currentTool: 'Bash', waitingOn: wait })).toBe('CI wait');
  });
  it('does not claim success while a legacy status is pending, failed or unreadable', () => {
    const checks = { total_count: 1, check_runs: [{ status: 'completed', conclusion: 'success' }] };
    expect(ciPhaseFromCommit(checks, { total_count: 1, statuses: [{}], state: 'pending' })).toBe('queued');
    expect(ciPhaseFromCommit(checks, { total_count: 1, statuses: [{}], state: 'failure' })).toBe('failed');
    expect(ciPhaseFromCommit(checks, {})).toBe('unknown');
    expect(ciPhaseFromCommit(checks, { total_count: 0, statuses: [], state: 'pending' })).toBe('passed');
    expect(ciPhaseFromCommit({ total_count: 0, check_runs: [] }, { total_count: 0, statuses: [] })).toBe('unknown');
  });
  it('only probes explicit bounded identities on github.com', () => {
    expect(ciWaitProbePath(wait)).toBeNull();
    expect(ciWaitProbePath({ ...wait, repo: '../..', runId: 1 })).toBeNull();
    expect(ciWaitProbePath({ ...wait, repo: 'owner/repo', runId: 42 })).toBe('repos/owner/repo/actions/runs/42');
  });
  it('distinguishes missing, cancelled and incomplete evidence from pass/fail', () => {
    for (const value of [null, {}, { status: 'completed', conclusion: 'cancelled' }, { total_count: 2, check_runs: [{ status: 'completed', conclusion: 'success' }] }]) {
      expect(ciPhaseFromResponse(value)).toBe('unknown');
    }
    expect(ciPhaseFromResponse({ status: 'completed', conclusion: 'success' })).toBe('passed');
    expect(ciPhaseFromResponse({ status: 'completed', conclusion: 'failure' })).toBe('failed');
    expect(ciPhaseFromResponse({ status: 'in_progress', conclusion: null })).toBe('running');
  });
});

it('reports counts only for complete readable evidence', () => {
  const checks = { total_count: 2, check_runs: [{ status: 'completed', conclusion: 'success' }, { status: 'in_progress' }] };
  expect(ciCheckCounts(checks, { total_count: 1, statuses: [{ state: 'failure' }] })).toEqual({ total: 3, passed: 1, failed: 1, pending: 1 });
  expect(ciCheckCounts({ ...checks, total_count: 3 }, { total_count: 0, statuses: [] })).toBeUndefined();
  expect(ciCheckCounts(checks, { total_count: 1, statuses: [{ state: 'unknown' }] })).toBeUndefined();
});
