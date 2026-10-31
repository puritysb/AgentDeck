import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { rawSessionId, parseDaemonConfiguration, parsePixooConfiguration, type DaemonConfiguration, type PixooConfiguration } from '@agentdeck/shared';
import type { SessionOrderStore } from './session-order-store.js';

export function readConfigurationSettings(directory: string): Record<string, unknown> {
  try {
    const root = JSON.parse(readFileSync(join(directory,'settings.json'),'utf8'));
    if (!root || typeof root !== 'object' || Array.isArray(root)) throw new Error('invalid_settings');
    return root;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error('settings_unreadable');
  }
}
function atomic(directory: string, name: string, value: unknown): void {
  mkdirSync(directory,{recursive:true});
  const file = join(directory,name), tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp,JSON.stringify(value),{mode:0o600}); renameSync(tmp,file);
}
export function readPixooConfiguration(directory: string): PixooConfiguration {
  const root = readConfigurationSettings(directory);
  const rows = root.pixooDevices ?? [];
  if (!Array.isArray(rows)) throw new Error('invalid_pixoo_configuration');
  const pixoo = parsePixooConfiguration({autoDiscover: root.pixooAutoDiscover === true, devices: rows.map(d => ({
    ip:d?.ip, ...(d?.name !== undefined ? {name:d.name} : {}), brightness:d?.brightness ?? 100, animation:d?.animation ?? 'single-frame',
  }))});
  if (!pixoo) throw new Error('invalid_pixoo_configuration');
  return pixoo;
}
export function writePixooConfiguration(directory: string, value: PixooConfiguration): void {
  const root = readConfigurationSettings(directory);
  const old = Array.isArray(root.pixooDevices) ? root.pixooDevices : [];
  root.pixooDevices = value.devices.map(d => {
    const row = {...(old.find(r=>r?.ip===d.ip) ?? {}), ...d};
    if (d.name === undefined) delete row.name;
    return row;
  });
  root.pixooAutoDiscover = value.autoDiscover;
  atomic(directory,'settings.json',root);
}
export function pixooRevision(pixoo: PixooConfiguration): string {
  // Field order is explicit so Swift's canonical JSON can hash the same bytes.
  const stable = JSON.stringify(pixoo, (_k,v) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0)) : v);
  return createHash('sha256').update(stable).digest('hex');
}
export class DaemonConfigurationStore {
  constructor(private readonly directory: string, private readonly order: SessionOrderStore) {}
  snapshot(): DaemonConfiguration {
    // Do not turn corrupt existing files into an authoritative empty snapshot.
    try {
      const raw = JSON.parse(readFileSync(join(this.directory,'session-order.json'),'utf8'));
      if (raw?.version !== 1 || !raw.pins || typeof raw.pins !== 'object' || Array.isArray(raw.pins)) throw new Error('invalid_session_order');
      const pins = Object.entries(raw.pins).map(([id,value]) => {
        const p = value as Record<string,unknown> | null;
        return {id:rawSessionId(id),weight:p?.weight,updatedAt:p?.updatedAt,lastSeenAt:p?.lastSeenAt};
      });
      if (!parseDaemonConfiguration({version:1,pins,pixoo:{devices:[],autoDiscover:false}})) throw new Error('invalid_session_order');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const value = parseDaemonConfiguration({version:1,pins:this.order.list(),pixoo:readPixooConfiguration(this.directory)});
    if (!value) throw new Error('invalid_configuration');
    return value;
  }
  adopt(value: DaemonConfiguration): void {
    const before = this.snapshot();
    if (JSON.stringify(before) === JSON.stringify(value)) return;
    atomic(this.directory,`daemon-configuration-profile-${randomUUID()}.json`,{configuration:before,localPixooRows:readConfigurationSettings(this.directory).pixooDevices??[]});
    // The durable peer checkpoint is retained until both compatibility writes
    // complete. A failed adoption is replayed before any device module starts.
    writePixooConfiguration(this.directory,value.pixoo);
    this.order.replace(value.pins);
  }
}
