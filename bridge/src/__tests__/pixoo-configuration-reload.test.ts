import { afterEach, expect, it, vi } from 'vitest';
import { renderTideFrame, TIDE_LOOP } from '../pixoo/pixoo-tide.js';
const client = vi.hoisted(() => ({ brightness: vi.fn(async () => true), channel: vi.fn(async () => true) }));
vi.mock('../pixoo/pixoo-client.js', async original => ({
  ...await original<typeof import('../pixoo/pixoo-client.js')>(),
  setBrightness: client.brightness, switchToCustomChannel: client.channel,
  pushFrame: vi.fn(async () => true), pushFrames: vi.fn(async () => true), clearText: vi.fn(async () => true),
  stopProbeTimer: vi.fn(), onDeviceStatusChange: vi.fn(),
}));
import { startPixooBridge, reloadPixooDevices, stopPixooBridge, broadcastPixoo, pixooDeviceCount, getPixooModuleHealth, renderPreviewFrame } from '../pixoo/pixoo-bridge.js';
afterEach(async () => { await stopPixooBridge(); vi.clearAllTimers(); vi.useRealTimers(); vi.clearAllMocks(); });
it('hot-reloads without waking a dimmed display or creating duplicate stream timers', () => {
  vi.useFakeTimers();
  startPixooBridge([{ip:'127.0.0.2',brightness:80,animation:'tide'}]);
  expect(getPixooModuleHealth()).toMatchObject({configuredDeviceCount:1,displayDimmed:false});
  broadcastPixoo({type:'display_state',displayOn:false,dim:{enabled:true,mode:'min',level:7}} as never);
  expect(getPixooModuleHealth().displayDimmed).toBe(true);
  client.brightness.mockClear(); const timers = vi.getTimerCount();
  reloadPixooDevices([{ip:'127.0.0.2',brightness:27,animation:'loop'}]);
  expect(client.brightness).toHaveBeenLastCalledWith('127.0.0.2',7);
  expect(vi.getTimerCount()).toBe(timers); expect(pixooDeviceCount()).toBe(1);
  broadcastPixoo({type:'display_state',displayOn:true} as never);
  expect(getPixooModuleHealth().displayDimmed).toBe(false);
  expect(client.brightness).toHaveBeenLastCalledWith('127.0.0.2',27);
  reloadPixooDevices([]); expect(pixooDeviceCount()).toBe(0);
  expect(getPixooModuleHealth()).toMatchObject({configuredDeviceCount:0,deviceIps:[]});
});

it('previews the configured Tide panel scene instead of a different aquarium', () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
  startPixooBridge([{ ip: '127.0.0.2', animation: 'tide' }]);
  broadcastPixoo({ type: 'sessions_list', sessions: [], dot: null });
  const now = Date.now();
  expect(renderPreviewFrame(64)).toEqual(renderTideFrame(null, null, [], now, Math.floor(now / TIDE_LOOP.picSpeedMs)));
  reloadPixooDevices([{ ip: '127.0.0.2', animation: 'single-frame' }]);
  expect(renderPreviewFrame(64)).not.toEqual(renderTideFrame(null, null, [], now, 0));
});
