/**
 * OpenClaw exec-approval: what the user sees, and whether they can answer it.
 *
 * The real one (2026-08-17): the deck sat on `PERMIT?` for approvals nobody
 * could read or resolve. Three independent defects, all silent:
 *
 *  1. The adapter read `payload.command` / `payload.ask` flat. The Gateway
 *     nests them under `request`, so every field was undefined and the prompt
 *     collapsed to the literal "Approve tool execution?".
 *  2. It answered with `decision: 'allow'`. The Gateway accepts only
 *     allow-once / allow-always / deny and validates the decision BEFORE the id
 *     lookup, so the resolve was rejected, the rejection went to a `debug()`
 *     line that is off by default, and the approval stayed pending.
 *  3. A run cancelled while an approval was outstanding emits no
 *     `exec.approval.resolved`, so nothing ever cleared the prompt.
 *
 * These tests drive the adapter with real Gateway frames.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../apme/index.js', () => ({
  getApme: () => ({ collector: { ingestSpan: vi.fn() } }),
}));

import { OpenClawAdapter } from '../adapters/openclaw.js';
import type { AdapterEvent, AdapterParserEvent, TimelineEntry } from '@agentdeck/shared';

type RpcCall = { method: string; params: Record<string, unknown> };
type ParserEvent = AdapterParserEvent;

/** Adapter + captured timeline rows, parser events, and outbound RPCs. */
function harness(rpcResult: Promise<unknown> = Promise.resolve({ ok: true })) {
  const adapter = new OpenClawAdapter({ autoReconnect: false });
  const rows: TimelineEntry[] = [];
  const parser: ParserEvent[] = [];
  const rpcs: RpcCall[] = [];
  adapter.on('event', (evt: AdapterEvent) => {
    if (evt.source === 'timeline' && evt.entry) rows.push(evt.entry);
    if (evt.source === 'parser') parser.push(evt as ParserEvent);
  });
  (adapter as unknown as { rpcCall(m: string, p: Record<string, unknown>): Promise<unknown> })
    .rpcCall = (method, params) => {
      rpcs.push({ method, params });
      return rpcResult;
    };
  const gw = (event: string, payload: Record<string, unknown>) =>
    (adapter as unknown as { handleGatewayEvent(e: string, p: Record<string, unknown>): void })
      .handleGatewayEvent(event, payload);
  return { adapter, rows, parser, rpcs, gw };
}

/** The shape `buildRequestedApprovalEvent` actually emits. */
const REQUESTED = {
  id: 'aa2318a0-dfdb-40e2-8238-c09e7905f95e',
  createdAtMs: 1_786_940_704_797,
  request: {
    command: 'rg --files-with-matches TODO src',
    cwd: '/Users/dev/project',
    ask: 'on-miss',
    allowedDecisions: ['allow-once', 'allow-always', 'deny'],
  },
};

describe('the user can see what they are approving', () => {
  it('puts the real command on the timeline row and the prompt', () => {
    const { rows, parser, gw } = harness();
    gw('exec.approval.requested', REQUESTED);

    const request = rows.find((r) => r.type === 'tool_request')!;
    expect(request.raw).toBe('rg --files-with-matches TODO src');
    expect(request.raw).not.toContain('Approve tool execution');
    expect(request.detail).toContain('cwd: /Users/dev/project');
    expect(request.approvalId).toBe(REQUESTED.id);
    expect(request.status).toBe('pending');

    const prompt = parser.find((e) => e.event === 'permission_prompt')!;
    expect(prompt.data?.question).toBe('rg --files-with-matches TODO src');
    expect((prompt.data?.options as Array<{ label: string }>).map((o) => o.label))
      .toEqual(['Allow once', 'Always allow', 'Deny']);
  });

  it('exposes the prompt for the session row', () => {
    const { adapter, gw } = harness();
    expect(adapter.getPendingApproval()).toBeNull();
    gw('exec.approval.requested', REQUESTED);
    expect(adapter.getPendingApproval()?.command).toBe('rg --files-with-matches TODO src');
  });
});

describe('the user can actually resolve it', () => {
  it('sends a decision the Gateway accepts — never the bare "allow"', () => {
    const { adapter, gw, rpcs } = harness();
    gw('exec.approval.requested', REQUESTED);
    adapter.handleCommand({ type: 'select_option', index: 0 });

    expect(rpcs).toHaveLength(1);
    expect(rpcs[0].method).toBe('exec.approval.resolve');
    expect(rpcs[0].params).toEqual({ id: REQUESTED.id, decision: 'allow-once' });
    // The exact string that made every press a no-op.
    expect(rpcs[0].params.decision).not.toBe('allow');
  });

  it('maps each option index to its own decision', () => {
    for (const [index, decision] of [[0, 'allow-once'], [1, 'allow-always'], [2, 'deny']] as const) {
      const { adapter, gw, rpcs } = harness();
      gw('exec.approval.requested', REQUESTED);
      adapter.handleCommand({ type: 'select_option', index });
      expect(rpcs[0].params.decision).toBe(decision);
    }
  });

  it('resolves a shortcut `respond` press too', () => {
    const { adapter, gw, rpcs } = harness();
    gw('exec.approval.requested', REQUESTED);
    adapter.handleCommand({ type: 'respond', value: 'a' });
    expect(rpcs[0].params.decision).toBe('allow-always');
  });

  it('drops a press whose question echo names a different approval', () => {
    const { adapter, gw, rpcs } = harness();
    gw('exec.approval.requested', REQUESTED);
    adapter.handleCommand({ type: 'select_option', index: 0, question: 'rm -rf /' });
    expect(rpcs).toHaveLength(0);
  });

  it('accepts a truncated echo — small surfaces cut the question', () => {
    const { adapter, gw, rpcs } = harness();
    gw('exec.approval.requested', REQUESTED);
    adapter.handleCommand({ type: 'select_option', index: 0, question: 'rg --files-with' });
    expect(rpcs).toHaveLength(1);
  });

  it('keeps the prompt on screen when the resolve fails', async () => {
    // Clearing optimistically (as the old code did) left the user with no
    // prompt AND an approval still blocking the agent.
    const { adapter, gw, parser } = harness(Promise.reject(new Error('boom')));
    gw('exec.approval.requested', REQUESTED);
    adapter.handleCommand({ type: 'select_option', index: 0 });
    await new Promise((r) => setTimeout(r, 0));

    expect(adapter.getPendingApproval()?.id).toBe(REQUESTED.id);
    expect(parser.filter((e) => e.event === 'permission_prompt')).toHaveLength(2);
  });
});

describe('the prompt goes away when the approval does', () => {
  it('labels a real allow as approved (not denied)', () => {
    const { rows, parser, gw } = harness();
    gw('exec.approval.requested', REQUESTED);
    gw('exec.approval.resolved', { id: REQUESTED.id, decision: 'allow-once' });

    const resolved = rows.find((r) => r.type === 'tool_resolved')!;
    expect(resolved.status).toBe('approved');
    expect(resolved.raw).toBe('Approved');
    expect(parser.at(-1)?.event).toBe('spinner_start');
  });

  it('a deny ends the turn rather than resuming it', () => {
    const { parser, gw } = harness();
    gw('exec.approval.requested', REQUESTED);
    gw('exec.approval.resolved', { id: REQUESTED.id, decision: 'deny' });
    expect(parser.at(-1)?.event).toBe('idle');
  });

  it('closes the approval when the run is cancelled under it', () => {
    // The stuck state, exactly: approval requested at 13:18, run cancelled at
    // 13:24, no `resolved` event ever — deck pinned on PERMIT?.
    const { adapter, rows, parser, gw } = harness();
    gw('exec.approval.requested', REQUESTED);
    gw('chat', { state: 'aborted', runId: 'r1', sessionKey: 's1' });

    expect(adapter.getPendingApproval()).toBeNull();
    const resolved = rows.find((r) => r.type === 'tool_resolved')!;
    expect(resolved.approvalId).toBe(REQUESTED.id);
    // `abandoned`, NOT `denied` — nobody refused this. Writing `denied` here
    // made a user's deliberate refusal byte-identical to an approval that was
    // never answered, and the second is by far the commoner case: of 8 real
    // approvals on 2026-08-23, 7 closed exactly this way after 75–402s.
    expect(resolved.status).toBe('abandoned');
    expect(resolved.raw).toContain('run cancelled');
    expect(parser.at(-1)?.event).toBe('idle');
  });

  it('closes the approval when the turn errors out', () => {
    const { adapter, gw } = harness();
    gw('exec.approval.requested', REQUESTED);
    gw('chat', { state: 'error', runId: 'r1', errorMessage: 'overloaded' });
    expect(adapter.getPendingApproval()).toBeNull();
  });

  it('adopts an approval that was already waiting when the adapter connected', async () => {
    // `exec.approval.requested` is a broadcast and is never replayed, so a
    // daemon restart under an outstanding approval used to leave the agent
    // blocked with an idle deck and no way to find out.
    const { adapter, rows, parser, rpcs } = harness();
    (adapter as unknown as { rpcCall(m: string, p: unknown): Promise<unknown> }).rpcCall =
      (method, params) => {
        rpcs.push({ method, params: params as Record<string, unknown> });
        return Promise.resolve(method === 'exec.approval.list' ? [REQUESTED] : { ok: true });
      };
    await (adapter as unknown as { adoptPendingApprovals(): Promise<void> }).adoptPendingApprovals();

    expect(adapter.getPendingApproval()?.id).toBe(REQUESTED.id);
    expect(rows.find((r) => r.type === 'tool_request')?.status).toBe('pending');
    expect(parser.some((e) => e.event === 'permission_prompt')).toBe(true);
  });

  it('adopts the OLDEST waiting approval — that is the one blocking the agent', async () => {
    const { adapter, rpcs } = harness();
    const older = { ...REQUESTED, id: 'older', createdAtMs: 1 };
    const newer = { ...REQUESTED, id: 'newer', createdAtMs: 2 };
    (adapter as unknown as { rpcCall(m: string, p: unknown): Promise<unknown> }).rpcCall =
      (method, params) => {
        rpcs.push({ method, params: params as Record<string, unknown> });
        return Promise.resolve(method === 'exec.approval.list' ? [newer, older] : { ok: true });
      };
    await (adapter as unknown as { adoptPendingApprovals(): Promise<void> }).adoptPendingApprovals();
    expect(adapter.getPendingApproval()?.id).toBe('older');
  });

  it('a resolution for a different approval does not clear the pending one', () => {
    const { adapter, gw } = harness();
    gw('exec.approval.requested', REQUESTED);
    gw('exec.approval.resolved', { id: 'some-other-id', decision: 'deny' });
    expect(adapter.getPendingApproval()?.id).toBe(REQUESTED.id);
  });
});

// A closed approval must say HOW it closed. Every non-approval used to write
// `denied`, so the timeline could not tell "the user said no" from "nobody was
// ever asked" — and only the second is a signal that the prompt failed to reach
// a human.
describe('a non-decision is not a denial', () => {
  it('a real deny stays denied', () => {
    const { rows, gw } = harness();
    gw('exec.approval.requested', REQUESTED);
    gw('exec.approval.resolved', { id: REQUESTED.id, decision: 'deny' });
    expect(rows.find((r) => r.type === 'tool_resolved')!.status).toBe('denied');
  });

  it('every abandonment reason lands in `abandoned`, and names itself in raw', () => {
    for (const [payload, reason] of [
      [{ state: 'aborted', runId: 'r1' }, 'run cancelled'],
      [{ state: 'error', runId: 'r1', errorMessage: 'overloaded' }, 'turn failed'],
    ] as const) {
      const { rows, gw } = harness();
      gw('exec.approval.requested', REQUESTED);
      gw('chat', payload as Record<string, unknown>);
      const resolved = rows.find((r) => r.type === 'tool_resolved')!;
      expect(resolved.status).toBe('abandoned');
      expect(resolved.raw).toContain(reason);
    }
  });

  it('names WHICH OpenClaw session asked, falling back to the tracked one', () => {
    // The Gateway does not always put `sessionKey` on the approval body, but
    // the adapter has been tracking it off the chat stream all along. Without
    // it every approval reads as plain "OpenClaw" — a cron heartbeat and a
    // model-eval run are indistinguishable.
    const { adapter, gw } = harness();
    gw('chat', { state: 'delta', runId: 'r1', sessionKey: 'agent:main:eval-a03__r2' });
    gw('exec.approval.requested', REQUESTED);
    expect(adapter.getPendingApproval()!.sessionKey).toBe('agent:main:eval-a03__r2');
  });

  it('does not overwrite a sessionKey the request carried itself', () => {
    const { adapter, gw } = harness();
    gw('chat', { state: 'delta', runId: 'r1', sessionKey: 'agent:main:main' });
    gw('exec.approval.requested', {
      ...REQUESTED,
      request: { ...REQUESTED.request, sessionKey: 'agent:main:cron:abc' },
    });
    expect(adapter.getPendingApproval()!.sessionKey).toBe('agent:main:cron:abc');
  });
});
