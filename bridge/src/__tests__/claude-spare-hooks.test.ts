import { describe, expect, it, vi } from 'vitest';
import { claudeBackgroundRoleForHook, isClaudeSpareHook, parkedClaudeSessionId } from '../claude-spare-hooks.js';
import type { ProcInfo } from '../passive-observer.js';

const proc = (pid: number, ppid: number, command: string): ProcInfo => ({ pid, ppid, rssKb: 0, command });
const SPARE = proc(28616, 28603, 'claude bg-spare --bg-spare /tmp/cc-daemon-501/c1/spare/5b563000.claim.sock');
const SPARE_HOST = proc(28603, 28528, 'claude bg-pty-host --bg-pty-host /tmp/cc-daemon-501/c1/spare/5b563000.pty.sock 200 50 -- x --bg-spare y');
const JOB_HOST = proc(28613, 28528, '/x/ClaudeCode.app/Contents/MacOS/claude --bg-pty-host /tmp/cc-daemon-501/c1/pty/5b55b9d6.sock 272 56 -- x');
const JOB = proc(28723, 28613, '/Users/robin/.local/share/claude/versions/2.1.296 --session-id 5b55b9d6-c0e9-4309-9cff-24fffa6eb973 '
  + '--fork-session --resume /Users/robin/.claude/projects/-x/d385adf6-9e82-4567-8360-c8d9c9a4483b.jsonl');
const WINDOW = proc(2237, 1044, 'claude --resume');
const ALL = [SPARE, SPARE_HOST, JOB_HOST, JOB, WINDOW];

const classify = async (payload: Record<string, unknown>, cached: ProcInfo[], fresh = vi.fn(async () => ALL), event = 'SessionStart') => {
  const role = await claudeBackgroundRoleForHook(event, payload, cached, fresh);
  return { role, spare: isClaudeSpareHook(payload, role), parked: parkedClaudeSessionId(payload, role), fresh };
};

describe('Claude background-job hooks', () => {
  it('drops a spare announcing itself, reading a fresh table when the cached one predates it', async () => {
    const r = await classify({ agentdeck_pid: 28616, source: 'startup', session_id: '64cf355f' }, [WINDOW]);
    expect(r.spare).toBe(true);
    expect(r.fresh).toHaveBeenCalledTimes(1);
  });

  it('keeps a claimed spare compacting, every non-start event, and real windows', async () => {
    expect((await classify({ agentdeck_pid: 28616, source: 'compact' }, ALL)).spare).toBe(false);
    expect((await classify({ agentdeck_pid: 2237, source: 'startup' }, ALL)).spare).toBe(false);
    const prompt = await classify({ agentdeck_pid: 28616 }, ALL, undefined, 'UserPromptSubmit');
    expect(prompt.role).toBeUndefined();
    expect(prompt.fresh).not.toHaveBeenCalled();
  });

  it('names the parked conversation a background job continues', async () => {
    const r = await classify({ agentdeck_pid: 28723, source: 'resume', session_id: '5b55b9d6-c0e9-4309-9cff-24fffa6eb973' }, ALL);
    expect(r.spare).toBe(false);
    expect(r.parked).toBe('d385adf6-9e82-4567-8360-c8d9c9a4483b');
  });

  it('an unknown pid never drops or retires anything', async () => {
    expect((await classify({ source: 'startup' }, [], vi.fn(async () => []))).role).toBeUndefined();
    const failing = await classify({ agentdeck_pid: 999, source: 'startup' }, [], vi.fn(async () => { throw new Error('ps failed'); }));
    expect(failing.spare).toBe(false);
    expect(failing.parked).toBeUndefined();
  });
});
