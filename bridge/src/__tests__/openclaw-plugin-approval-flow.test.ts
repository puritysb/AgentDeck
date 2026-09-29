/**
 * OpenClaw plugin-approval (`plugin.approval.*`, issue #309): the parallel
 * surface to exec approvals for a request that is not a shell command.
 *
 * Mirrors `openclaw-approval-flow.test.ts` structurally — same harness, same
 * failure-mode coverage (gone-vs-no-information resolve, reconcile, adoption,
 * expiry) — plus the coexistence cases specific to running two independent
 * approval queues through one "one prompt on screen at a time" model.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../apme/index.js', () => ({
  getApme: () => ({ collector: { ingestSpan: vi.fn() } }),
}));

import { OpenClawAdapter } from '../adapters/openclaw.js';
import type { AdapterEvent, AdapterParserEvent, TimelineEntry } from '@agentdeck/shared';

type RpcCall = { method: string; params: Record<string, unknown> };
type ParserEvent = AdapterParserEvent;

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

/** The shape `buildRequestedApprovalEvent(record, 'plugin')` actually emits. */
// No `expiresAtMs`, mirroring exec's own `REQUESTED` fixture: a real value
// far enough in the future to exercise the adapter overflows Node's 32-bit
// `setTimeout` delay (clamped to ~1ms) and fires the expiry sweep almost
// immediately — a real trap this test would otherwise trip on every run
// relative to "now" rather than testing what it means to.
const PLUGIN_REQUESTED = {
  approvalKind: 'plugin' as const,
  id: 'plugin:aa2318a0-dfdb-40e2-8238-c09e7905f95e',
  createdAtMs: 1_786_940_704_797,
  request: {
    pluginId: 'telegram',
    title: 'Send message to #ops',
    description: 'Post a status update to the #ops channel.',
    severity: 'warning' as const,
    allowedDecisions: ['allow-once', 'allow-always', 'deny'],
  },
};

const EXEC_REQUESTED = {
  id: 'exec-aa2318a0',
  createdAtMs: 1_786_940_700_000,
  request: {
    command: 'rg --files-with-matches TODO src',
    allowedDecisions: ['allow-once', 'allow-always', 'deny'],
  },
};

describe('the user can see what they are approving', () => {
  it('puts the plugin title on the timeline row and the prompt, labeled [Plugin]', () => {
    const { rows, parser, gw } = harness();
    gw('plugin.approval.requested', PLUGIN_REQUESTED);

    const request = rows.find((r) => r.type === 'tool_request')!;
    expect(request.raw).toBe('[Plugin] Send message to #ops');
    expect(request.detail).toContain('Post a status update to the #ops channel.');
    expect(request.approvalId).toBe(PLUGIN_REQUESTED.id);
    expect(request.status).toBe('pending');

    const prompt = parser.find((e) => e.event === 'permission_prompt')!;
    expect(prompt.data?.question).toBe('[Plugin] Send message to #ops');
    expect((prompt.data?.options as Array<{ label: string }>).map((o) => o.label))
      .toEqual(['Allow once', 'Always allow', 'Deny']);
  });

  it('exposes the prompt for the session row', () => {
    const { adapter, gw } = harness();
    expect(adapter.getPendingApproval()).toBeNull();
    gw('plugin.approval.requested', PLUGIN_REQUESTED);
    const pending = adapter.getPendingApproval();
    expect(pending?.id).toBe(PLUGIN_REQUESTED.id);
    // No `command` field — that is what distinguishes a plugin prompt from an
    // exec one at the wire-shape level (`openclaw-session.ts`'s label rule).
    expect(pending && 'command' in pending).toBe(false);
  });
});

describe('the user can actually resolve it', () => {
  it('sends a decision to plugin.approval.resolve, never exec.approval.resolve', () => {
    const { adapter, gw, rpcs } = harness();
    gw('plugin.approval.requested', PLUGIN_REQUESTED);
    adapter.handleCommand({ type: 'select_option', index: 0 });

    expect(rpcs).toHaveLength(1);
    expect(rpcs[0].method).toBe('plugin.approval.resolve');
    expect(rpcs[0].params).toEqual({ id: PLUGIN_REQUESTED.id, decision: 'allow-once' });
  });

  it('maps each option index to its own decision', () => {
    for (const [index, decision] of [[0, 'allow-once'], [1, 'allow-always'], [2, 'deny']] as const) {
      const { adapter, gw, rpcs } = harness();
      gw('plugin.approval.requested', PLUGIN_REQUESTED);
      adapter.handleCommand({ type: 'select_option', index });
      expect(rpcs[0].params.decision).toBe(decision);
    }
  });

  it('resolves a shortcut `respond` press too', () => {
    const { adapter, gw, rpcs } = harness();
    gw('plugin.approval.requested', PLUGIN_REQUESTED);
    adapter.handleCommand({ type: 'respond', value: 'a' });
    expect(rpcs[0].params.decision).toBe('allow-always');
  });

  it('drops a press whose question echo names a different approval', () => {
    const { adapter, gw, rpcs } = harness();
    gw('plugin.approval.requested', PLUGIN_REQUESTED);
    adapter.handleCommand({ type: 'select_option', index: 0, question: 'Delete account' });
    expect(rpcs).toHaveLength(0);
  });

  it('accepts the echo a device that renders the question actually sends — the [Plugin]-prefixed form', () => {
    // Every broadcast prefixes `[Plugin] ` onto the raw title so the user
    // knows which kind of approval they are answering (`rebroadcastPending
    // PluginApprovalPrompt` / `pluginPromptDict`), so a surface that echoes
    // back what it rendered sends THAT string, not the bare title. Comparing
    // against the unprefixed title would refuse every press from exactly the
    // surfaces rich enough to echo.
    const { adapter, gw, rpcs } = harness();
    gw('plugin.approval.requested', PLUGIN_REQUESTED);
    adapter.handleCommand({
      type: 'select_option', index: 0, question: '[Plugin] Send message to #ops',
    });
    expect(rpcs).toHaveLength(1);
  });

  it('accepts a truncated prefixed echo — small surfaces cut the question', () => {
    const { adapter, gw, rpcs } = harness();
    gw('plugin.approval.requested', PLUGIN_REQUESTED);
    adapter.handleCommand({ type: 'select_option', index: 0, question: '[Plugin] Send mess' });
    expect(rpcs).toHaveLength(1);
  });

  it('keeps the prompt on screen when the resolve fails', async () => {
    const { adapter, gw, parser } = harness(Promise.reject(new Error('boom')));
    gw('plugin.approval.requested', PLUGIN_REQUESTED);
    adapter.handleCommand({ type: 'select_option', index: 0 });
    await new Promise((r) => setTimeout(r, 0));

    expect(adapter.getPendingApproval()?.id).toBe(PLUGIN_REQUESTED.id);
    expect(parser.filter((e) => e.event === 'permission_prompt')).toHaveLength(2);
  });
});

describe('the prompt goes away when the approval does', () => {
  it('labels a real allow as approved (plugin)', () => {
    const { rows, parser, gw } = harness();
    gw('plugin.approval.requested', PLUGIN_REQUESTED);
    gw('plugin.approval.resolved', { id: PLUGIN_REQUESTED.id, decision: 'allow-once' });

    const resolved = rows.find((r) => r.type === 'tool_resolved')!;
    expect(resolved.status).toBe('approved');
    expect(resolved.raw).toBe('Approved (plugin)');
    expect(parser.at(-1)?.event).toBe('spinner_start');
  });

  it('a deny does not resume', () => {
    const { parser, gw } = harness();
    gw('plugin.approval.requested', PLUGIN_REQUESTED);
    gw('plugin.approval.resolved', { id: PLUGIN_REQUESTED.id, decision: 'deny' });
    expect(parser.at(-1)?.event).toBe('idle');
  });

  it('a resolution for a different approval does not clear the pending one', () => {
    const { adapter, gw } = harness();
    gw('plugin.approval.requested', PLUGIN_REQUESTED);
    gw('plugin.approval.resolved', { id: 'some-other-id', decision: 'deny' });
    expect(adapter.getPendingApproval()?.id).toBe(PLUGIN_REQUESTED.id);
  });

  it('adopts a plugin approval that was already waiting when the adapter connected', async () => {
    const { adapter, rows, parser, rpcs } = harness();
    (adapter as unknown as { rpcCall(m: string, p: unknown): Promise<unknown> }).rpcCall =
      (method, params) => {
        rpcs.push({ method, params: params as Record<string, unknown> });
        if (method === 'plugin.approval.list') return Promise.resolve([PLUGIN_REQUESTED]);
        if (method === 'exec.approval.list') return Promise.resolve([]);
        return Promise.resolve({ ok: true });
      };
    await (adapter as unknown as { adoptPendingApprovals(): Promise<void> }).adoptPendingApprovals();

    expect(adapter.getPendingApproval()?.id).toBe(PLUGIN_REQUESTED.id);
    expect(rows.find((r) => r.type === 'tool_request')?.status).toBe('pending');
    expect(parser.some((e) => e.event === 'permission_prompt')).toBe(true);
  });

  it('adopts BOTH kinds independently on connect — neither adoption clobbers the other', async () => {
    const { adapter, rpcs } = harness();
    (adapter as unknown as { rpcCall(m: string, p: unknown): Promise<unknown> }).rpcCall =
      (method, params) => {
        rpcs.push({ method, params: params as Record<string, unknown> });
        if (method === 'exec.approval.list') return Promise.resolve([EXEC_REQUESTED]);
        if (method === 'plugin.approval.list') return Promise.resolve([PLUGIN_REQUESTED]);
        return Promise.resolve({ ok: true });
      };
    await (adapter as unknown as { adoptPendingApprovals(): Promise<void> }).adoptPendingApprovals();

    // EXEC_REQUESTED is older (createdAtMs 1_786_940_700_000 <
    // PLUGIN_REQUESTED's 1_786_940_704_797), so it is the one presented.
    expect(adapter.getPendingApproval()?.id).toBe(EXEC_REQUESTED.id);
  });
});

describe('exec and plugin approvals coexist without dropping either', () => {
  it('presents the OLDER of the two — the plugin one, when it arrived first', () => {
    const { adapter, gw } = harness();
    gw('plugin.approval.requested', PLUGIN_REQUESTED); // createdAtMs 1_786_940_704_797
    gw('exec.approval.requested', {
      ...EXEC_REQUESTED,
      createdAtMs: 1_786_940_900_000, // later than the plugin one
    });
    expect(adapter.getPendingApproval()?.id).toBe(PLUGIN_REQUESTED.id);
  });

  it('resolving the shown one surfaces the queued one automatically — nothing is lost', () => {
    const { adapter, gw } = harness();
    gw('plugin.approval.requested', PLUGIN_REQUESTED);
    gw('exec.approval.requested', {
      ...EXEC_REQUESTED,
      createdAtMs: 1_786_940_900_000,
    });
    expect(adapter.getPendingApproval()?.id).toBe(PLUGIN_REQUESTED.id);

    gw('plugin.approval.resolved', { id: PLUGIN_REQUESTED.id, decision: 'allow-once' });

    // The exec approval was never touched by the plugin one's lifecycle — it
    // is still there, and is now the active prompt.
    expect(adapter.getPendingApproval()?.id).toBe(EXEC_REQUESTED.id);
  });

  // Review round (2026-09-12). The assertion above is on the ROW's fields, and
  // it passed while the deck showed nothing: resolving emitted spinner_start,
  // the daemon maps that onto gatewaySessionState, the row left
  // awaiting_permission, sessionTier stopped returning 'attention', and no
  // surface rendered PERM for the survivor. Assert the STATE the survivor
  // needs, not only that it is still in the slot.
  it('resolving the shown one keeps the row in awaiting_permission for the survivor', () => {
    const { adapter, gw, parser } = harness();
    gw('plugin.approval.requested', PLUGIN_REQUESTED);
    gw('exec.approval.requested', { ...EXEC_REQUESTED, createdAtMs: 1_786_940_900_000 });
    parser.length = 0;

    gw('plugin.approval.resolved', { id: PLUGIN_REQUESTED.id, decision: 'allow-once' });

    const events = parser.map((p) => p.event);
    expect(events).toContain('permission_prompt');
    // An allow would otherwise emit spinner_start → 'processing', which is
    // exactly what drops the row out of attention while a prompt is live.
    expect(events).not.toContain('spinner_start');
    expect(events).not.toContain('idle');
    // The re-broadcast carries the SURVIVOR's question, not the resolved one's.
    const shown = parser.find((p) => p.event === 'permission_prompt');
    expect(String(shown?.data?.question ?? '')).toContain(EXEC_REQUESTED.request.command);
  });

  it('an expiring approval does not idle the row while the other kind is live', () => {
    const { adapter, gw, parser } = harness();
    gw('plugin.approval.requested', PLUGIN_REQUESTED);
    gw('exec.approval.requested', { ...EXEC_REQUESTED, createdAtMs: 1_786_940_900_000 });
    parser.length = 0;

    (adapter as unknown as { abandonPendingPluginApproval(id: string, why: string): void })
      .abandonPendingPluginApproval(PLUGIN_REQUESTED.id as string, 'Expired');

    expect(parser.map((p) => p.event)).not.toContain('idle');
    expect(parser.map((p) => p.event)).toContain('permission_prompt');
    expect(adapter.getPendingApproval()?.id).toBe(EXEC_REQUESTED.id);
  });

  it('with nothing left pending, a resolution still settles the activity state', () => {
    const { gw, parser } = harness();
    gw('plugin.approval.requested', PLUGIN_REQUESTED);
    parser.length = 0;
    gw('plugin.approval.resolved', { id: PLUGIN_REQUESTED.id, decision: 'allow-once' });
    expect(parser.map((p) => p.event)).toContain('spinner_start');
  });

  it('a second plugin approval closes the one it supersedes instead of dropping it', () => {
    const { adapter, gw, rows } = harness();
    gw('plugin.approval.requested', PLUGIN_REQUESTED);
    rows.length = 0;

    const SECOND = { ...PLUGIN_REQUESTED, id: 'plugin-approval-2', createdAtMs: 1_786_940_800_000 };
    gw('plugin.approval.requested', SECOND);

    // Plugin approvals come from independent plugins and cron jobs, so two can
    // genuinely overlap. The displaced one used to vanish with its tool_request
    // row stuck at pending and no way to answer it from any surface.
    const closed = rows.find((r) => r.approvalId === PLUGIN_REQUESTED.id);
    expect(closed?.status).toBe('abandoned');
    expect(String(closed?.raw ?? '')).toContain('Superseded');
    expect(adapter.getPendingApproval()?.id).toBe(SECOND.id);
  });

  it('a failing exec catch-up does not skip the plugin catch-up', async () => {
    const { adapter, rpcs } = harness();
    (adapter as unknown as { rpcCall(m: string, p: Record<string, unknown>): Promise<unknown> })
      .rpcCall = (method, params) => {
        rpcs.push({ method, params });
        // An older Gateway without the method, an error frame, an RPC timeout.
        if (method === 'exec.approval.list') return Promise.reject(new Error('no such method'));
        return Promise.resolve({ approvals: [PLUGIN_REQUESTED] });
      };

    await (adapter as unknown as { adoptPendingApprovals(): Promise<void> }).adoptPendingApprovals();

    expect(rpcs.map((r) => r.method)).toContain('plugin.approval.list');
    expect(adapter.getPendingApproval()?.id).toBe(PLUGIN_REQUESTED.id);
  });

  it('a press routes to the ACTIVE prompt\'s own resolve method, never the other kind\'s', () => {
    const { adapter, gw, rpcs } = harness();
    gw('plugin.approval.requested', PLUGIN_REQUESTED); // active (older)
    gw('exec.approval.requested', {
      ...EXEC_REQUESTED,
      createdAtMs: 1_786_940_900_000,
    });
    adapter.handleCommand({ type: 'select_option', index: 2 }); // deny
    expect(rpcs).toHaveLength(1);
    expect(rpcs[0].method).toBe('plugin.approval.resolve');
    expect(rpcs[0].params.id).toBe(PLUGIN_REQUESTED.id);
  });
});

describe('plugin.approval.removed — real wire protocol, no .d.ts declaration', () => {
  it('abandons the pending prompt named by the removed id', () => {
    const { adapter, rows, gw } = harness();
    gw('plugin.approval.requested', PLUGIN_REQUESTED);
    gw('plugin.approval.removed', { id: PLUGIN_REQUESTED.id });

    expect(adapter.getPendingApproval()).toBeNull();
    const resolved = rows.filter((r) => r.type === 'tool_resolved').at(-1)!;
    expect(resolved.status).toBe('abandoned');
    expect(resolved.raw).toContain('Removed by Gateway');
  });

  it('never resolves — removed carries no decision, so it cannot approve/deny', () => {
    const { rows, gw } = harness();
    gw('plugin.approval.requested', PLUGIN_REQUESTED);
    gw('plugin.approval.removed', { id: PLUGIN_REQUESTED.id });
    const resolved = rows.filter((r) => r.type === 'tool_resolved').at(-1)!;
    expect(resolved.status).not.toBe('approved');
    expect(resolved.status).not.toBe('denied');
  });

  it('ignores a removed for a different id', () => {
    const { adapter, gw } = harness();
    gw('plugin.approval.requested', PLUGIN_REQUESTED);
    gw('plugin.approval.removed', { id: 'some-other-id' });
    expect(adapter.getPendingApproval()?.id).toBe(PLUGIN_REQUESTED.id);
  });

  it('makes no claim about an unreadable payload', () => {
    const { adapter, gw } = harness();
    gw('plugin.approval.requested', PLUGIN_REQUESTED);
    gw('plugin.approval.removed', {});
    expect(adapter.getPendingApproval()?.id).toBe(PLUGIN_REQUESTED.id);
  });
});

// Gateway disconnect abandons BOTH kinds (every id becomes meaningless on
// reconnect), but a chat turn ending does NOT abandon a plugin approval —
// unlike exec, nothing guarantees a plugin approval is scoped to the turn
// that happens to be closing elsewhere.
describe('turn-scoping asymmetry from exec', () => {
  it('a turn abort does NOT abandon a pending plugin approval', () => {
    const { adapter, gw } = harness();
    gw('plugin.approval.requested', PLUGIN_REQUESTED);
    gw('chat', { state: 'aborted', runId: 'r1', sessionKey: 's1' });
    expect(adapter.getPendingApproval()?.id).toBe(PLUGIN_REQUESTED.id);
  });

  it('a turn error does NOT abandon a pending plugin approval', () => {
    const { adapter, gw } = harness();
    gw('plugin.approval.requested', PLUGIN_REQUESTED);
    gw('chat', { state: 'error', runId: 'r1', errorMessage: 'overloaded' });
    expect(adapter.getPendingApproval()?.id).toBe(PLUGIN_REQUESTED.id);
  });

  it('gateway disconnect DOES abandon a pending plugin approval', () => {
    const { adapter, gw } = harness();
    gw('plugin.approval.requested', PLUGIN_REQUESTED);
    (adapter as unknown as { ws: { on(e: string, cb: () => void): void } | null }).ws = null;
    // Simulate the 'close' handler's abandon call directly — it is wired on
    // `this.ws.on('close', ...)`, which the harness never opens a real socket
    // for; the unit under test is the abandon call itself.
    (adapter as unknown as {
      abandonPendingPluginApproval(id: string, reason: string): void;
    }).abandonPendingPluginApproval(PLUGIN_REQUESTED.id, 'gateway disconnected');
    expect(adapter.getPendingApproval()).toBeNull();
  });
});

describe('an approval the Gateway has already dropped comes off the deck', () => {
  const withOpenSocket = (adapter: OpenClawAdapter) => {
    (adapter as unknown as { ws: unknown }).ws = { readyState: 1 };
  };
  const reconcile = (adapter: OpenClawAdapter) =>
    (adapter as unknown as { reconcilePendingPluginApproval(): Promise<void> })
      .reconcilePendingPluginApproval();

  it('abandons the prompt when the resolve says the approval is gone', async () => {
    const { adapter, gw, rows, parser } = harness(
      Promise.reject(Object.assign(new Error('unknown or expired approval id'), {
        gatewayCode: 'INVALID_REQUEST', details: { reason: 'APPROVAL_NOT_FOUND' },
      })),
    );
    gw('plugin.approval.requested', PLUGIN_REQUESTED);
    adapter.handleCommand({ type: 'select_option', index: 0 });
    await new Promise((r) => setTimeout(r, 0));

    expect(adapter.getPendingApproval()).toBeNull();
    const closed = rows.filter((r) => r.type === 'tool_resolved').at(-1)!;
    expect(closed.status).toBe('abandoned');
    expect(parser.filter((e) => e.event === 'permission_prompt')).toHaveLength(1);
  });

  it('keeps the prompt when the resolve merely failed to get through', async () => {
    const { adapter, gw, parser } = harness(Promise.reject(new Error('Gateway disconnected')));
    gw('plugin.approval.requested', PLUGIN_REQUESTED);
    adapter.handleCommand({ type: 'select_option', index: 0 });
    await new Promise((r) => setTimeout(r, 0));

    expect(adapter.getPendingApproval()?.id).toBe(PLUGIN_REQUESTED.id);
    expect(parser.filter((e) => e.event === 'permission_prompt')).toHaveLength(2);
  });

  it('abandons a prompt the Gateway no longer lists', async () => {
    const { adapter, gw, rows } = harness(Promise.resolve([]));
    gw('plugin.approval.requested', PLUGIN_REQUESTED);
    withOpenSocket(adapter);
    await reconcile(adapter);

    expect(adapter.getPendingApproval()).toBeNull();
    expect(rows.filter((r) => r.type === 'tool_resolved').at(-1)?.status).toBe('abandoned');
  });

  it('keeps a prompt that is still pending', async () => {
    const { adapter, gw } = harness(Promise.resolve([PLUGIN_REQUESTED]));
    gw('plugin.approval.requested', PLUGIN_REQUESTED);
    withOpenSocket(adapter);
    await reconcile(adapter);
    expect(adapter.getPendingApproval()?.id).toBe(PLUGIN_REQUESTED.id);
  });

  it('a failed or unreadable list answer changes nothing', async () => {
    for (const answer of [
      Promise.reject(new Error('RPC timeout: plugin.approval.list (id=r9)')),
      Promise.resolve(null),
      Promise.resolve({ unexpected: true }),
    ]) {
      const { adapter, gw } = harness(answer);
      gw('plugin.approval.requested', PLUGIN_REQUESTED);
      withOpenSocket(adapter);
      await reconcile(adapter);
      expect(adapter.getPendingApproval()?.id).toBe(PLUGIN_REQUESTED.id);
    }
  });
});
