import { describe, it, expect } from 'vitest';
import { CodexApprovalProbes } from '../codex-approval-probe.js';

describe('pending Codex approval reads', () => {
  it('does not publish a delayed read after later session activity', async () => {
    const probes = new CodexApprovalProbes();
    const pending = probes.begin('s1');
    let finish!: (value: string) => void;
    const delayed = new Promise<string>(resolve => { finish = resolve; });
    const publish = async () => (await delayed) === 'user' && pending.current();
    const result = publish();
    probes.invalidate('s1');
    finish('user');
    expect(await result).toBe(false);
    pending.dispose();
  });

  it('retains live hold twins through parallel progress, but not after close or a terminal hook', () => {
    const probes = new CodexApprovalProbes();
    let alive = true;
    const notification = probes.begin('s1'), hold = probes.begin('s1', () => alive);
    probes.invalidate('s1', false);
    expect(notification.current()).toBe(true);
    expect(hold.current()).toBe(true);
    alive = false;
    probes.invalidate('s1', false);
    expect(notification.current()).toBe(false);
    expect(hold.current()).toBe(false);
    const next = probes.begin('s1', () => true);
    probes.invalidate('s1');
    expect(next.current()).toBe(false);
    notification.dispose(); hold.dispose(); next.dispose();
  });

  it('keeps twins and other sessions independent, including a new read after invalidation', () => {
    const probes = new CodexApprovalProbes();
    const notification = probes.begin('s1'), hold = probes.begin('s1'), other = probes.begin('s2');
    notification.dispose();
    expect(hold.current()).toBe(true);
    probes.invalidate('s1');
    const next = probes.begin('s1');
    hold.dispose();
    expect(hold.current()).toBe(false);
    expect(next.current()).toBe(true);
    expect(other.current()).toBe(true);
    next.dispose(); other.dispose();
  });
});
