import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionFocusRelay } from '../session-focus-relay.js';
import type { BridgeEvent, PluginCommand } from '../types.js';

/** A stand-in for a worker's live push socket (ws.OPEN === 1). */
function fakeSender() {
  return { readyState: 1, send: vi.fn() } as any;
}

function lastFrame(sender: any): any {
  const calls = sender.send.mock.calls;
  return JSON.parse(calls[calls.length - 1][0]);
}

const ID = 'sess-remote-1';

describe('SessionFocusRelay — same-socket reverse control (primary)', () => {
  let relay: SessionFocusRelay;
  let events: BridgeEvent[];

  beforeEach(() => {
    relay = new SessionFocusRelay();
    events = [];
    relay.setEventHandler((e) => events.push(e));
  });

  it('focuses via the live push socket and sends session_focus_down', () => {
    const sender = fakeSender();
    relay.setSameSocketResolver((id) => (id === ID ? sender : null));

    relay.focus(ID);

    expect(relay.getFocusedSessionId()).toBe(ID);
    expect(lastFrame(sender)).toEqual({ type: 'session_focus_down', sessionId: ID });
  });

  it('routes a command down the push socket as session_command_down', () => {
    const sender = fakeSender();
    relay.setSameSocketResolver(() => sender);
    relay.focus(ID);

    const cmd: PluginCommand = { type: 'interrupt' } as PluginCommand;
    expect(relay.routeCommand(cmd)).toBe(true);
    expect(lastFrame(sender)).toEqual({ type: 'session_command_down', sessionId: ID, command: cmd });
  });

  it('ignores commands that are not in the routed set', () => {
    const sender = fakeSender();
    relay.setSameSocketResolver(() => sender);
    relay.focus(ID);
    sender.send.mockClear();

    expect(relay.routeCommand({ type: 'query_usage' } as PluginCommand)).toBe(false);
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('relays only RELAYED_EVENTS from the focused session up', () => {
    const sender = fakeSender();
    relay.setSameSocketResolver(() => sender);
    relay.focus(ID);

    relay.ingestReverseEvent(ID, { type: 'state_update' } as BridgeEvent);
    relay.ingestReverseEvent(ID, { type: 'timeline_event' } as BridgeEvent); // not relayed
    relay.ingestReverseEvent('other', { type: 'state_update' } as BridgeEvent); // wrong session

    expect(events.map((e) => e.type)).toEqual(['state_update']);
  });

  it('sends session_unfocus_down on unfocus and clears focus', () => {
    const sender = fakeSender();
    relay.setSameSocketResolver(() => sender);
    relay.focus(ID);
    sender.send.mockClear();

    relay.unfocus();

    expect(lastFrame(sender)).toEqual({ type: 'session_unfocus_down', sessionId: ID });
    expect(relay.getFocusedSessionId()).toBeNull();
  });

  it('drops focus when the worker push socket closes', () => {
    const sender = fakeSender();
    relay.setSameSocketResolver(() => sender);
    relay.focus(ID);

    relay.handleSenderClosed(ID);
    expect(relay.getFocusedSessionId()).toBeNull();
    // A later event for the (now unfocused) session is ignored.
    relay.ingestReverseEvent(ID, { type: 'state_update' } as BridgeEvent);
    expect(events).toHaveLength(0);
  });

  it('a stale socket close does not tear down focus held by a newer socket', () => {
    const oldSock = fakeSender();
    const newSock = fakeSender();
    relay.setSameSocketResolver(() => oldSock);
    relay.focus(ID);

    // Worker reconnected: registration swapped the sender, focus migrates.
    relay.migrateSender(ID, newSock);
    expect(lastFrame(oldSock)).toEqual({ type: 'session_unfocus_down', sessionId: ID });
    expect(lastFrame(newSock)).toEqual({ type: 'session_focus_down', sessionId: ID });

    // The OLD socket's close handler fires late — focus must survive.
    relay.handleSenderClosed(ID, oldSock);
    expect(relay.getFocusedSessionId()).toBe(ID);

    // Commands route down the NEW socket.
    newSock.send.mockClear();
    expect(relay.routeCommand({ type: 'interrupt' } as PluginCommand)).toBe(true);
    expect(lastFrame(newSock).type).toBe('session_command_down');

    // The NEW socket closing does drop focus.
    relay.handleSenderClosed(ID, newSock);
    expect(relay.getFocusedSessionId()).toBeNull();
  });

  it('migrateSender is a no-op for unfocused sessions and same-socket re-registers', () => {
    const sender = fakeSender();
    relay.migrateSender(ID, sender); // not focused — nothing happens
    expect(sender.send).not.toHaveBeenCalled();

    relay.setSameSocketResolver(() => sender);
    relay.focus(ID);
    sender.send.mockClear();
    relay.migrateSender(ID, sender); // same socket — nothing happens
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('stamps relayed prompt_options with the session identity', () => {
    const sender = fakeSender();
    relay.setSameSocketResolver(() => sender);
    relay.focus(ID);

    relay.ingestReverseEvent(ID, { type: 'prompt_options', options: ['Yes', 'No'] } as unknown as BridgeEvent);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'prompt_options', sessionId: ID, focusedSessionId: ID });
  });

  it('does nothing when neither a push socket nor a local session exists', () => {
    relay.setSameSocketResolver(() => null);
    relay.focus('nonexistent');
    expect(relay.getFocusedSessionId()).toBeNull();
    expect(relay.routeCommand({ type: 'interrupt' } as PluginCommand)).toBe(false);
  });
});
