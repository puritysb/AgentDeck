import { describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { State, type SessionInfo, type SessionSetting } from '@agentdeck/shared';
import { BridgeClient } from '../bridge-client.js';
import { SessionSlotManager, type DeckLayout } from '../session-slot-manager.js';
import { renderSlotConfig } from '../renderers/slot-svg.js';

const layouts: Array<[string, DeckLayout]> = [
  ['classic', { columns: 5, rows: 3, keyCount: 15, family: 'streamdeck' }],
  ['xl', { columns: 8, rows: 4, keyCount: 32, family: 'streamdeck' }],
  ['sdplus', { columns: 4, rows: 2, keyCount: 8, family: 'streamdeckplus' }],
];
const gateway: SessionInfo = { id: 'openclaw-gateway', port: 18789, projectName: 'Synthetic Gateway', alive: true, agentType: 'openclaw', state: State.IDLE };
const options = Array.from({ length: 67 }, (_, i) => ({ id: `provider/model-${i}` }));
const settings: SessionSetting[] = ['model', 'effort'].map(key => ({ key: key as SessionSetting['key'], current: options[2].id, default: options[0].id, options }));

function configs(manager: SessionSlotManager, layout: DeckLayout) {
  return Array.from({ length: layout.keyCount }, (_, slot) => manager.getSlotConfig(slot, layout));
}
function rendered(manager: SessionSlotManager, layout: DeckLayout) {
  return configs(manager, layout).map(config => renderSlotConfig(config, { animFrame: 0, isStale: false, layout, detail: { state: State.IDLE } }));
}
function capture(name: string, tiles: string[], layout: DeckLayout) {
  if (!process.env.AGENTDECK_DECK_SIM_CAPTURE) return;
  const dir = process.env.AGENTDECK_DECK_SIM_CAPTURE;
  mkdirSync(dir, { recursive: true });
  const nested = tiles.map((svg, i) => svg.replace('<svg ', `<svg x="${i % layout.columns * 144}" y="${Math.floor(i / layout.columns) * 144}" `));
  writeFileSync(`${dir}/${name}.svg`, `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.columns * 144}" height="${layout.rows * 144}">${nested.join('')}</svg>`);
}

describe.each(layouts)('%s production keypad controller + loopback settings peer', (name, layout) => {
  it('paginates both catalogs, shows stale-target refusal, retries, and ignores replies after BACK', async () => {
    const http = createServer();
    const server = new WebSocketServer({ server: http });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('missing loopback port');
    const client = new BridgeClient();
    const manager = new SessionSlotManager();
    let rejectMutation = true;
    let holdQuery = false;
    let heldReply: { socket: import('ws').WebSocket; reply: unknown } | undefined;
    const received: Array<Record<string, unknown>> = [];
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
    client.on('sessions_list', event => manager.updateSessions(event.sessions));
    client.on('session_settings', event => manager.applySessionSettings(event));
    try {
      client.connect(address.port);
      await vi.waitFor(() => expect(manager.sessions).toHaveLength(1));
      manager.enterDetailView(gateway.id);
      for (const key of ['model', 'effort'] as const) {
        client.send(manager.openPicker(key)!);
        await vi.waitFor(() => expect(configs(manager, layout).some(c => c.type === 'setting-option')).toBe(true));
        const seen = new Set<string | null>();
        for (let page = 0; page < options.length + 1; page++) {
          const cells = configs(manager, layout);
          cells.filter(c => c.type === 'setting-option').forEach(c => seen.add(c.settingValue!));
          const more = cells.find(c => c.type === 'next-page');
          if (more?.label?.startsWith('1/')) capture(`${name}-${key}-picker`, rendered(manager, layout), layout);
          const [current, total] = more?.label?.split('/').map(Number) ?? [1, 1];
          if (current === total) break;
          manager.nextPage(layout);
        }
        expect(seen).toEqual(new Set([null, ...options.map(o => o.id)]));
        const lastOptionSlot = configs(manager, layout).findIndex(c => c.type === 'setting-option');
        const press = manager.handleSlotPress(lastOptionSlot, layout);
        expect(press.action).toBe('set-setting');
        const mutation = manager.beginSettingMutation(press.settingKey!, press.settingValue!)!;
        expect(mutation.targetSessionKey).toBe('agent:synthetic:main');
        client.send(mutation);
        await vi.waitFor(() => expect(configs(manager, layout).some(c => c.label === 'REFUSED')).toBe(true));
        expect(manager.pickerOpen).toBe(key);
        capture(`${name}-${key}-refused`, rendered(manager, layout), layout);
        rejectMutation = false;
        client.send(manager.beginSettingMutation(key, null)!);
        await vi.waitFor(() => expect(manager.pickerOpen).toBeNull());
        rejectMutation = true;
      }
      expect(received.filter(c => c.type === 'set_session_setting').map(c => c.value)).toContain(null);
      holdQuery = true;
      client.send(manager.openPicker('model')!);
      await vi.waitFor(() => expect(heldReply).toBeDefined());
      expect(manager.handleSlotPress(0, layout).action).toBe('close-picker');
      manager.closePicker();
      heldReply!.socket.send(JSON.stringify(heldReply!.reply));
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(manager.pickerOpen).toBeNull();
      expect(manager.focusedSessionId).toBe(gateway.id);
    } finally {
      manager.closePicker();
      client.disconnect();
      server.clients.forEach(socket => socket.terminate());
      await new Promise<void>(resolve => server.close(() => http.close(() => resolve())));
    }
  });

  it('renders row-specific observed readouts and repaints NOW after roster-only updates', () => {
    const manager = new SessionSlotManager();
    const row: SessionInfo = { ...gateway, id: 'observed:codex:synthetic', port: 0, agentType: 'codex-app', controlMode: 'observed', modelName: 'gpt-6-astra', effortLevel: 'ultra', permissionMode: 'workspace-write', activity: 'Inspecting synthetic fixture', contextPercent: 31 };
    manager.updateSessions([row]);
    manager.enterDetailView(row.id);
    const first = rendered(manager, layout).join('');
    expect(first).toContain('WORKSPACE-WRITE');
    expect(first).toContain('ultra');
    expect(first).toContain('context 31%');
    manager.updateSessions([{ ...row, activity: 'Synthetic fixture complete', contextPercent: 45 }]);
    const changed = rendered(manager, layout);
    expect(changed.join('')).toContain('context 45%');
    expect(changed.join('')).not.toBe(first);
    capture(`${name}-observed-now`, changed, layout);
  });
});
