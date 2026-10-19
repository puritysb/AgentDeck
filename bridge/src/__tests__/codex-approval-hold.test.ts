import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import type { ServerResponse } from 'http';
import { describe, expect, it, vi } from 'vitest';
import { codexApprovalDecisionBody, codexHoldReleasedBy } from '@agentdeck/shared';
import { CodexApprovalHolds } from '../codex-approval-hold.js';
import { isPendingRequest, passPending, registerPending, resolvePending } from '../permission-resolver.js';
import { CODEX_TERMINAL_EVENTS, buildCodexPermissionQuestion } from '../hook-codex-sessions.js';

const VECTORS = JSON.parse(readFileSync(
  fileURLToPath(new URL('../../../shared/codex-approval-hold-vectors.json', import.meta.url)), 'utf8')) as {
  decisions: Array<{ decision: string; body: unknown }>;
  capturedPermissionRequest: Record<string, unknown>;
  capturedQuestion: string;
  presses: Array<{ name: string; press: Record<string, unknown>; decision: 'allow' | 'deny' | null }>;
};

describe('Codex approval hold in the Node daemon', () => {
  it('reads the captured request as the question devices show', () => {
    expect(buildCodexPermissionQuestion(VECTORS.capturedPermissionRequest)).toBe(VECTORS.capturedQuestion);
  });

  it('releases a hold on every event that ends a Codex turn here', () => {
    for (const event of CODEX_TERMINAL_EVENTS) expect(codexHoldReleasedBy(event)).toBe(true);
  });
});

describe('CodexApprovalHolds', () => {
  it('keeps one hold per session and reports a turn that ended under it', () => {
    const holds = new CodexApprovalHolds();
    const first = holds.begin('s1');
    expect(holds.requestIdFor('s1')).toBe(first);
    expect(holds.finish('s1', first, 'allow')).toBe('allow');
    expect(holds.requestIdFor('s1')).toBeUndefined();

    const second = holds.begin('s1');
    expect(holds.end('s1')).toBe(second);
    // The release itself arrives as a pass; the record says why.
    expect(holds.finish('s1', second, 'pass')).toBe('ended');
    expect(holds.end('s1')).toBeUndefined();
  });

  it('ignores a release for a hold it no longer owns', () => {
    const holds = new CodexApprovalHolds();
    const current = holds.begin('s1');
    expect(holds.finish('s1', 'stale-request', 'pass')).toBe('pass');
    expect(holds.requestIdFor('s1')).toBe(current);
  });
});

describe('a deck press on an open hold', () => {
  const allow = { type: 'select_option', index: 0 };

  it('answers with the decision the shared press vectors name', () => {
    const holds = new CodexApprovalHolds();
    const requestId = holds.begin('s1');
    const shown = { question: VECTORS.capturedQuestion, requestId };
    for (const v of VECTORS.presses) {
      const press = holds.press('s1', v.press, shown);
      if (v.press.type !== 'select_option' && v.press.type !== 'respond') expect(press, v.name).toBeNull();
      else if (v.decision) expect(press, v.name).toEqual({ kind: 'answer', requestId, decision: v.decision });
      else expect(press, v.name).toEqual({ kind: 'not-an-answer' });
    }
  });

  it('leaves a session with no open hold to its usual route', () => {
    const holds = new CodexApprovalHolds();
    expect(holds.press('s1', allow, undefined)).toBeNull();
    holds.finish('s1', holds.begin('s1'), 'pass');
    expect(holds.press('s1', allow, undefined)).toBeNull();
    holds.begin('s2');
    expect(holds.press('s1', allow, undefined)).toBeNull();
  });

  it('drops a press that echoes a prompt the hold does not show', () => {
    const holds = new CodexApprovalHolds();
    const requestId = holds.begin('s1');
    const shown = { question: VECTORS.capturedQuestion, requestId };
    const answer = { kind: 'answer', requestId, decision: 'allow' };
    expect(holds.press('s1', { ...allow, question: VECTORS.capturedQuestion }, shown)).toEqual(answer);
    // A device that cut the question short still names it.
    expect(holds.press('s1', { ...allow, question: VECTORS.capturedQuestion.slice(0, 26) }, shown)).toEqual(answer);
    expect(holds.press('s1', { ...allow, question: 'Approve Bash: rm -rf build' }, shown)).toEqual({ kind: 'stale' });
    // The row no longer carries this hold's button.
    expect(holds.press('s1', { ...allow, question: VECTORS.capturedQuestion }, { question: VECTORS.capturedQuestion }))
      .toEqual({ kind: 'stale' });
    expect(holds.press('s1', { ...allow, question: VECTORS.capturedQuestion }, undefined)).toEqual({ kind: 'stale' });
    // No echo leaves nothing to check: the open hold is answered.
    expect(holds.press('s1', allow, undefined)).toEqual(answer);
  });
});

/** A held hook response, as the resolver sees one. */
function fakeResponse(): ServerResponse & { body?: string } {
  const res = {
    body: undefined as string | undefined,
    writeHead: vi.fn(),
    end: vi.fn((chunk?: string) => { res.body = chunk ?? ''; }),
  };
  return res as unknown as ServerResponse & { body?: string };
}

describe('permission resolver with the Codex decision format', () => {
  it('answers a device decision in the format the Codex hook prints', () => {
    const res = fakeResponse();
    const onResolved = vi.fn();
    registerPending('codex-req-allow', res, {
      sessionId: 's1', timeoutMs: 60_000, buildBody: codexApprovalDecisionBody, onResolved,
    });
    expect(resolvePending('codex-req-allow', 'deny')).toBe('s1');
    expect(JSON.parse(res.body ?? '')).toEqual(VECTORS.decisions.find((d) => d.decision === 'deny')?.body);
    expect(onResolved).toHaveBeenCalledWith('deny');
  });

  it('releases a hold early as an empty pass and tells its owner', () => {
    const res = fakeResponse();
    const onResolved = vi.fn();
    registerPending('codex-req-pass', res, {
      sessionId: 's1', timeoutMs: 60_000, buildBody: codexApprovalDecisionBody, onResolved,
    });
    expect(passPending('codex-req-pass')).toBe(true);
    expect(res.body).toBe('');
    expect(onResolved).toHaveBeenCalledWith('pass');
    expect(isPendingRequest('codex-req-pass')).toBe(false);
    expect(passPending('codex-req-pass')).toBe(false);
  });

  it('still times out to a pass', () => {
    vi.useFakeTimers();
    try {
      const res = fakeResponse();
      registerPending('codex-req-timeout', res, {
        sessionId: 's1', timeoutMs: 25_000, buildBody: codexApprovalDecisionBody,
      });
      vi.advanceTimersByTime(25_000);
      expect(res.body).toBe('');
      expect(isPendingRequest('codex-req-timeout')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
