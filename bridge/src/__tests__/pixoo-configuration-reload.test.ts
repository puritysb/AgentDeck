import { afterEach, expect, it, vi } from 'vitest';
const client = vi.hoisted(() => ({ brightness: vi.fn(async () => true), channel: vi.fn(async () => true) }));
vi.mock('../pixoo/pixoo-client.js', async original => ({
  ...await original<typeof import('../pixoo/pixoo-client.js')>(),
  setBrightness: client.brightness, switchToCustomChannel: client.channel,
  pushFrame: vi.fn(async () => true), pushFrames: vi.fn(async () => true), clearText: vi.fn(async () => true),
  stopProbeTimer: vi.fn(), onDeviceStatusChange: vi.fn(),
}));
import { startPixooBridge, reloadPixooDevices, stopPixooBridge, broadcastPixoo, pixooDeviceCount } from '../pixoo/pixoo-bridge.js';
afterEach(async () => { await stopPixooBridge(); vi.clearAllTimers(); vi.useRealTimers(); vi.clearAllMocks(); });
it('hot-reloads without waking a dimmed display or creating duplicate stream timers', () => {
  vi.useFakeTimers();
  startPixooBridge([{ip:'127.0.0.2',brightness:80,animation:'tide'}]);
  broadcastPixoo({type:'display_state',displayOn:false,dim:{enabled:true,mode:'min',level:7}} as never);
  client.brightness.mockClear(); const timers = vi.getTimerCount();
  reloadPixooDevices([{ip:'127.0.0.2',brightness:27,animation:'loop'}]);
  expect(client.brightness).toHaveBeenLastCalledWith('127.0.0.2',7);
  expect(vi.getTimerCount()).toBe(timers); expect(pixooDeviceCount()).toBe(1);
  broadcastPixoo({type:'display_state',displayOn:true} as never);
  expect(client.brightness).toHaveBeenLastCalledWith('127.0.0.2',27);
  reloadPixooDevices([]); expect(pixooDeviceCount()).toBe(0);
});
