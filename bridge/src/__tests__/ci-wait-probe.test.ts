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

it('leaves skipped and neutral check runs out of the commit verdict and counts', () => {
  const done = (conclusion: string) => ({ status: 'completed', conclusion });
  const none = { total_count: 0, statuses: [] };
  // Measured on a real PR: 23 passing, 2 skipped, 1 neutral, 2 still running.
  const running = { total_count: 4, check_runs: [done('success'), done('skipped'), done('neutral'), { status: 'in_progress' }] };
  expect(ciPhaseFromCommit(running, none)).toBe('running');
  expect(ciCheckCounts(running, none)).toEqual({ total: 2, passed: 1, failed: 0, pending: 1 });
  const settled = { total_count: 3, check_runs: [done('success'), done('skipped'), done('neutral')] };
  expect(ciPhaseFromCommit(settled, none)).toBe('passed');
  expect(ciPhaseFromCommit({ total_count: 2, check_runs: [done('failure'), done('skipped')] }, none)).toBe('failed');
  // Nothing but skipped rows validates nothing; a status may still decide.
  const onlySkipped = { total_count: 2, check_runs: [done('skipped'), done('neutral')] };
  expect(ciPhaseFromCommit(onlySkipped, none)).toBe('unknown');
  expect(ciCheckCounts(onlySkipped, none)).toBeUndefined();
  expect(ciPhaseFromCommit(onlySkipped, { total_count: 1, statuses: [{}], state: 'success' })).toBe('passed');
  // Cancelled is not successful validation and still blocks a verdict.
  expect(ciPhaseFromCommit({ total_count: 2, check_runs: [done('success'), done('cancelled')] }, none)).toBe('unknown');
  // A single skipped workflow run did not validate anything.
  expect(ciPhaseFromResponse(done('skipped'))).toBe('unknown');
});
