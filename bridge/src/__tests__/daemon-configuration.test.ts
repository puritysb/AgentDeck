import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseDaemonConfiguration } from '@agentdeck/shared';
import { DaemonConfigurationStore, readPixooConfiguration, pixooRevision, writePixooConfiguration } from '../daemon-configuration.js';
import { SessionOrderStore } from '../session-order-store.js';
import { DaemonCheckpointStore, stagePeerCheckpoint, parseDaemonCheckpoint } from '../daemon-checkpoint.js';
import { AutonomousPocketEngine } from '../pocket-autonomy.js';
import { OutboxIdempotencyLedger } from '../card-feed.js';
const vectors = JSON.parse(readFileSync(new URL('../../../shared/daemon-configuration-vectors.json',import.meta.url),'utf8'));

describe('minimized owner configuration', () => {
  for (const v of vectors) it(v.name, () => {
    const result = parseDaemonConfiguration(v.value);
    expect(!!result).toBe(v.valid);
    if (result) expect(pixooRevision(result.pixoo)).toBe(v.pixooRevision);
  });
  it('adopts the active profile in both directions, preserving unrelated keys and clearing removed entries', () => {
    const dirs = [mkdtempSync(join(tmpdir(),'agentdeck-config-a-')),mkdtempSync(join(tmpdir(),'agentdeck-config-b-'))];
    try {
      const orders = dirs.map(dir=>new SessionOrderStore({file:join(dir,'session-order.json')}).load());
      const configs = dirs.map((dir,i)=>new DaemonConfigurationStore(dir,orders[i]));
      dirs.forEach(dir=>writeFileSync(join(dir,'settings.json'),JSON.stringify({untouched:{value:'preserved'},pixooDevices:[{ip:'127.0.0.2',future:'local-only'}]})));
      orders[0].set('abc-1',-5); orders[1].set('old',10);
      const pixoo = vectors[1].value.pixoo;
      writePixooConfiguration(dirs[0],pixoo);
      const engine = () => new AutonomousPocketEngine({persist:false});
      const a = new DaemonCheckpointStore(dirs[0],engine(),new OutboxIdempotencyLedger(),configs[0]);
      expect(stagePeerCheckpoint(dirs[1],a.capture(true))).toBe(true);
      const b = new DaemonCheckpointStore(dirs[1],engine(),new OutboxIdempotencyLedger(),configs[1]);
      expect(orders[1].weightFor('abc-1')).toBe(-5); expect(orders[1].weightFor('old')).toBeUndefined();
      expect(readPixooConfiguration(dirs[1])).toEqual(pixoo);
      expect(JSON.parse(readFileSync(join(dirs[1],'settings.json'),'utf8'))).toMatchObject({untouched:{value:'preserved'},pixooDevices:[{future:'local-only'}]});
      expect(readdirSync(dirs[1]).some(n=>n.startsWith('daemon-configuration-profile-'))).toBe(true);
      orders[1].clear('abc-1'); writePixooConfiguration(dirs[1],{devices:[],autoDiscover:false});
      expect(stagePeerCheckpoint(dirs[0],b.capture(true))).toBe(true);
      new DaemonCheckpointStore(dirs[0],engine(),new OutboxIdempotencyLedger(),configs[0]);
      expect(configs[0].snapshot().pins).toEqual([]); expect(configs[0].snapshot().pixoo.devices).toEqual([]);
      // An offline local edit is retained on a peerless restart, rather than
      // replaced by the previous checkpoint's older settings.
      orders[0].set('offline',7);
      const restarted = new DaemonCheckpointStore(dirs[0],engine(),new OutboxIdempotencyLedger(),configs[0]);
      expect(parseDaemonCheckpoint(restarted.capture())?.configuration?.pins[0].id).toBe('offline');
    } finally { dirs.forEach(d=>rmSync(d,{recursive:true,force:true})); }
  });
  it('refuses corrupt existing settings without overwriting them', () => {
    const dir = mkdtempSync(join(tmpdir(),'agentdeck-config-corrupt-'));
    try {
      writeFileSync(join(dir,'settings.json'),'{broken');
      expect(()=>writePixooConfiguration(dir,{devices:[],autoDiscover:false})).toThrow();
      expect(readFileSync(join(dir,'settings.json'),'utf8')).toBe('{broken');
      writeFileSync(join(dir,'settings.json'),'{}');
      const corrupt = JSON.stringify({version:1,pins:{good:{weight:-5,updatedAt:1,lastSeenAt:Date.now()},bad:{weight:'broken'}}});
      writeFileSync(join(dir,'session-order.json'),corrupt);
      const order = new SessionOrderStore({file:join(dir,'session-order.json')}).load();
      expect(()=>new DaemonConfigurationStore(dir,order).snapshot()).toThrow();
      expect(readFileSync(join(dir,'session-order.json'),'utf8')).toBe(corrupt);
    } finally { rmSync(dir,{recursive:true,force:true}); }
  });
});
