import { rawSessionId, SESSION_WEIGHT_MIN, SESSION_WEIGHT_MAX, MAX_SESSION_ORDER_PINS } from './session-utils.js';

/** Minimized same-machine settings contract; credentials and grants are excluded. */
export const DAEMON_CONFIGURATION_POLICY = { version: 1, maxBodyBytes: 16384, maxDevices: 16, maxNameChars: 128, maxIdBytes: 256,
  maxCounter: Number.MAX_SAFE_INTEGER, handoverHeader: 'X-AgentDeck-Configuration', subscriptionId: 'subscribe-configuration-v1', animations: ['single-frame', 'loop', 'tide'] } as const;
export interface ConfigurationPin { id: string; weight: number; updatedAt: number; lastSeenAt: number }
export interface PixooConfigurationDevice { ip: string; name?: string; brightness: number; animation: 'single-frame' | 'loop' | 'tide' }
export interface PixooConfiguration { devices: PixooConfigurationDevice[]; autoDiscover: boolean }
export interface DaemonConfiguration { version: 1; pins: ConfigurationPin[]; pixoo: PixooConfiguration }
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
export function parsePixooConfiguration(raw: unknown): PixooConfiguration | null {
  if (!record(raw) || !keys(raw, ['devices', 'autoDiscover']) || typeof raw.autoDiscover !== 'boolean'
    || !Array.isArray(raw.devices) || raw.devices.length > DAEMON_CONFIGURATION_POLICY.maxDevices) return null;
  const devices: PixooConfigurationDevice[] = [];
  for (const d of raw.devices) {
    if (!record(d) || !keys(d, ['ip', 'name', 'brightness', 'animation']) || typeof d.ip !== 'string'
      || !/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(d.ip) || d.ip.split('.').some(n => Number(n) > 255)
      || devices.some(prior => prior.ip === d.ip)
      || (d.name !== undefined && (typeof d.name !== 'string' || Array.from(d.name).length > DAEMON_CONFIGURATION_POLICY.maxNameChars
        || /[\x00-\x1f\x7f]/.test(d.name)))
      || !integer(d.brightness) || d.brightness > 100
      || !DAEMON_CONFIGURATION_POLICY.animations.includes(d.animation as PixooConfigurationDevice['animation'])) return null;
    devices.push({ ip: d.ip, ...(d.name !== undefined ? { name: d.name as string } : {}), brightness: d.brightness,
      animation: d.animation as PixooConfigurationDevice['animation'] });
  }
  return { devices, autoDiscover: raw.autoDiscover };
}
export function parseDaemonConfiguration(raw: unknown): DaemonConfiguration | null {
  if (!record(raw) || !keys(raw, ['version','pins','pixoo']) || raw.version !== 1 || !Array.isArray(raw.pins)
    || raw.pins.length > MAX_SESSION_ORDER_PINS) return null;
  const pixoo = parsePixooConfiguration(raw.pixoo); if (!pixoo) return null;
  const pins: ConfigurationPin[] = [];
  for (const p of raw.pins) {
    if (!record(p) || !keys(p, ['id','weight','updatedAt','lastSeenAt']) || typeof p.id !== 'string'
      || !/^[A-Za-z0-9:_.\/-]+$/.test(p.id) || p.id.length > DAEMON_CONFIGURATION_POLICY.maxIdBytes
      || rawSessionId(p.id) !== p.id || pins.some(prior => prior.id === p.id)
      || typeof p.weight !== 'number' || !Number.isInteger(p.weight) || p.weight === 0 || p.weight < SESSION_WEIGHT_MIN || p.weight > SESSION_WEIGHT_MAX
      || !integer(p.updatedAt) || !integer(p.lastSeenAt)) return null;
    pins.push({ id: p.id, weight: p.weight, updatedAt: p.updatedAt, lastSeenAt: p.lastSeenAt });
  }
  pins.sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { version: 1, pins, pixoo };
}
