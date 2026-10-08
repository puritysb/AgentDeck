import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildSessionDeck, State, type DeckView, type SessionInfo, type SessionSetting } from '@agentdeck/shared';
import { DaemonClient } from '../daemon-client.js';
import { discoverDaemonPort } from '../daemon-discovery.js';
import { StateStore } from '../state-store.js';
import { settingsPickerAfterResponse } from '../setting-picker-state.js';
import { deckViewSignature } from '../deck-signature.js';

vi.mock('../daemon-discovery.js', () => ({ discoverDaemonPort: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const positions = Array.from({ length: 14 }, (_, i) => `${i % 5}_${Math.floor(i / 5)}`);
const gateway: SessionInfo = { id: 'openclaw-gateway', port: 18789, projectName: 'Synthetic Gateway', alive: true, agentType: 'openclaw', state: State.IDLE };
const options = Array.from({ length: 37 }, (_, i) => ({ id: `provider/model-${i}` }));
const settings: SessionSetting[] = ['model', 'effort'].map(key => ({ key: key as SessionSetting['key'], current: options[2].id, default: options[0].id, options }));
function capture(name: string, cells: ReturnType<typeof buildSessionDeck>) {
  const dir = process.env.AGENTDECK_DECK_SIM_CAPTURE;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const nested = [...cells].map(([position, cell]) => {
    const [x, y] = position.split('_').map(Number);
    return cell.svg.replace('<svg ', `<svg x="${x * 144}" y="${y * 144}" `);
  });
  writeFileSync(`${dir}/d200h-${name}.svg`, `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="432">${nested.join('')}</svg>`);
}

describe('14-key D200H production transport/controller simulation', () => {
  it('paginates catalogs over the real wire, keeps later-page refusals visible and ignores closed requests', async () => {
    const http = createServer();
    const server = new WebSocketServer({ server: http });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('missing loopback port');
    vi.mocked(discoverDaemonPort).mockResolvedValue(address.port);
    const client = new DaemonClient();
    const store = new StateStore();
    let view: DeckView = { mode: 'detail', openSessionId: gateway.id };
    let rejectMutation = true;
    let holdQuery = false;
    let heldReply: { socket: import('ws').WebSocket; reply: unknown } | undefined;
    const received: Array<Record<string, unknown>> = [];
    const deck = () => buildSessionDeck(store.toLayoutInput(view.openSessionId), { ...view, settings: store.settingsFor(gateway.id) }, positions);
    server.on('connection', socket => {
      socket.send(JSON.stringify({ type: 'sessions_list', sessions: [gateway] }));
      socket.on('message', bytes => {
        const command = JSON.parse(bytes.toString());
        received.push(command);
        if (!['query_session_settings', 'set_session_setting'].includes(command.type)) return;
        const reply = { type: 'session_settings', sessionId: command.sessionId, requestId: command.requestId, targetSessionKey: command.targetSessionKey ?? 'agent:synthetic:main', settings,
          ...(command.type === 'set_session_setting' && rejectMutation ? { error: 'Session changed; reopen picker' } : {}) };
        if (holdQuery && command.type === 'query_session_settings') heldReply = { socket, reply };
        else socket.send(JSON.stringify(reply));
      });
    });
    client.on('connected', () => store.setConnected(true));
    client.on('event', event => {
      const pending = store.settingsFor(gateway.id)?.pending;
      if (store.apply(event) && event.type === 'session_settings') view = settingsPickerAfterResponse(view, event, pending);
    });
    try {
      client.start();
      await vi.waitFor(() => expect(store.toLayoutInput().allSessions).toHaveLength(1));
      for (const key of ['model', 'effort'] as const) {
        view = { ...view, picker: key, page: 0 };
        client.send({ ...store.beginSettingsQuery(gateway.id) });
        await vi.waitFor(() => expect(store.settingsFor(gateway.id)?.pending).toBeUndefined());
        const seen = new Set<string | null>();
        for (let page = 0; page < options.length; page++) {
          const cells = deck();
          for (const cell of cells.values()) if (cell.action?.kind === 'setting-select') seen.add(cell.action.value);
          if (page === 0) capture(`${key}-picker`, cells);
          if (seen.size === options.length + 1) break;
          const more = [...cells.values()].find(cell => cell.action?.kind === 'page')!.action;
          if (more?.kind !== 'page') throw new Error('missing page action');
          view = { ...view, page: (view.page ?? 0) + more.delta };
        }
        expect(seen).toEqual(new Set([null, ...options.map(option => option.id)]));
        expect(view.page).toBeGreaterThan(0);
        const choice = [...deck().values()].find(cell => cell.action?.kind === 'setting-select')!.action;
        if (choice?.kind !== 'setting-select') throw new Error('missing choice');
        client.send({ ...store.beginSettingMutation(choice.sessionId, choice.key, choice.value)! });
        await vi.waitFor(() => expect(store.settingsFor(gateway.id)?.error).toBeTruthy());
        expect(view).toMatchObject({ picker: key, page: 0 });
        expect([...deck().values()].map(cell => cell.svg).join('')).toContain('REFUSED');
        capture(`${key}-refused`, deck());
        rejectMutation = false;
        client.send({ ...store.beginSettingMutation(gateway.id, key, null)! });
        await vi.waitFor(() => expect(view.picker).toBeUndefined());
        rejectMutation = true;
      }
      expect(received.some(command => command.type === 'client_register' && command.clientType === 'ulanzi-plugin')).toBe(true);
      holdQuery = true;
      view = { ...view, picker: 'model' };
      client.send({ ...store.beginSettingsQuery(gateway.id) });
      await vi.waitFor(() => expect(heldReply).toBeDefined());
      expect(deck().get('0_0')?.action).toEqual({ kind: 'picker-close' });
      store.cancelSettings();
      view = { ...view, picker: undefined, page: 0 };
      heldReply!.socket.send(JSON.stringify(heldReply!.reply));
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(view).toMatchObject({ picker: undefined, openSessionId: gateway.id });
    } finally {
      store.cancelSettings();
      client.stop();
      server.clients.forEach(socket => socket.terminate());
      await new Promise<void>(resolve => server.close(() => http.close(() => resolve())));
    }
  });

  it('invalidates and renders observed NOW changes using only the canonical roster row', () => {
    const store = new StateStore();
    store.setConnected(true);
    const row: SessionInfo = { ...gateway, id: 'observed:codex:synthetic', port: 0, agentType: 'codex-app', controlMode: 'observed', modelName: 'gpt-6-astra', effortLevel: 'ultra', permissionMode: 'workspace-write', activity: 'Inspecting synthetic fixture', contextPercent: 31 };
    store.apply({ type: 'sessions_list', sessions: [row] });
    const view: DeckView = { mode: 'detail', openSessionId: row.id };
    const firstInput = store.toLayoutInput(row.id);
    const firstSignature = deckViewSignature(firstInput, view, positions);
    store.apply({ type: 'sessions_list', sessions: [{ ...row, activity: 'Synthetic fixture complete', contextPercent: 45 }] });
    const updated = store.toLayoutInput(row.id);
    expect(deckViewSignature(updated, view, positions)).not.toBe(firstSignature);
    const cells = buildSessionDeck(updated, view, positions);
    const rendered = [...cells.values()].map(cell => cell.svg).join('');
    expect(rendered).toContain('WORKSPACE-WRITE');
    expect(rendered).toContain('ultra');
    expect(rendered).toContain('context 45%');
    capture('observed-now', cells);
  });
});
