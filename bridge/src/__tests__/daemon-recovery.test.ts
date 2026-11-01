import { createRequire } from 'node:module';
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonRecoveryStore, DaemonRecoverySession, configuredRecovery, selectRecovery, recoveryConsent, disconnectRecovery } from '../daemon-recovery.js';
import { DaemonCheckpointStore, parseDaemonCheckpoint } from '../daemon-checkpoint.js';
import { DaemonConfigurationStore, writePixooConfiguration } from '../daemon-configuration.js';
import { SessionOrderStore } from '../session-order-store.js';
import { AutonomousPocketEngine } from '../pocket-autonomy.js';
import { OutboxIdempotencyLedger } from '../card-feed.js';
const roots: string[]=[];
const temp=()=>{const p=mkdtempSync(join(tmpdir(),'agentdeck-recovery-'));roots.push(p);return p;};
afterEach(()=>{for(const p of roots.splice(0))rmSync(p,{recursive:true,force:true});});
function owner(directory: string,shared: string) {
  mkdirSync(directory,{recursive:true});
  const order=new SessionOrderStore({file:join(directory,'session-order.json')}).load();
  const configuration=new DaemonConfigurationStore(directory,order);
  const pocket=new AutonomousPocketEngine({persist:false}),ledger=new OutboxIdempotencyLedger();
  const session=new DaemonRecoverySession(new DaemonRecoveryStore(shared),directory);
  const checkpoint=new DaemonCheckpointStore(directory,pocket,ledger,configuration,session);
  return {order,configuration,pocket,ledger,checkpoint};
}
describe('explicit local cold recovery',()=>{
  it.skipIf(process.platform!=='darwin')('discovers one-time consent on a later ordinary Node launch but never from an explicit test profile',()=>{
    const priorHome=process.env.HOME,priorData=process.env.AGENTDECK_DATA_DIR;
    try {
      const home=temp(),a=temp(),b=temp(),shared=join(home,'Library','Application Support','AgentDeck Recovery');
      process.env.HOME=home;delete process.env.AGENTDECK_DATA_DIR;mkdirSync(shared,{recursive:true});
      owner(a,shared);recoveryConsent(shared,true);
      expect(configuredRecovery(b)).toBeDefined();
      selectRecovery(b,shared);recoveryConsent(shared,false);disconnectRecovery(b);
      expect(configuredRecovery(b)).toBeUndefined();
      recoveryConsent(shared,true);expect(configuredRecovery(b)).toBeDefined();
      rmSync(join(b,'daemon-recovery-location.json'));
      recoveryConsent(shared,false);writeFileSync(join(shared,'agentdeck-recovery.sqlite'),'{disabled backup');
      expect(configuredRecovery(b)).toBeUndefined();
      process.env.AGENTDECK_DATA_DIR=b;expect(configuredRecovery(b)).toBeUndefined();
    } finally {
      if(priorHome===undefined)delete process.env.HOME;else process.env.HOME=priorHome;
      if(priorData===undefined)delete process.env.AGENTDECK_DATA_DIR;else process.env.AGENTDECK_DATA_DIR=priorData;
    }
  });
  it('recovers both directions while the other owner was absent, including removals and aggregates',()=>{
    const shared=temp(),a=temp(),b=temp();
    const first=owner(a,shared);first.order.set('session-a',-7);
    writePixooConfiguration(a,{devices:[{ip:'127.0.0.2',brightness:27,animation:'tide'}],autoDiscover:false});
    first.pocket.adopt({...first.pocket.snapshot(),feedbackCount:9});const oldInbox=first.checkpoint.capture(true);
    const second=owner(b,shared);
    expect(second.order.weightFor('session-a')).toBe(-7);expect(second.pocket.snapshot().feedbackCount).toBe(9);
    expect(second.configuration.snapshot().pixoo.devices[0].brightness).toBe(27);
    second.order.clear('session-a');writePixooConfiguration(b,{devices:[],autoDiscover:false});second.checkpoint.capture(true);
    const localPins=JSON.parse(readFileSync(join(a,'session-order.json'),'utf8'));localPins.pins['session-a'].lastSeenAt+=60000;
    writeFileSync(join(a,'session-order.json'),JSON.stringify(localPins));
    writeFileSync(join(a,'daemon-checkpoint-peer.json'),oldInbox);
    const restored=owner(a,shared);expect(restored.order.list()).toEqual([]);expect(restored.configuration.snapshot().pixoo.devices).toEqual([]);
    expect(restored.pocket.snapshot().feedbackCount).toBe(9);
    const payload=new DaemonRecoveryStore(shared).load()!.payload;
    expect(parseDaemonCheckpoint(payload)?.configuration).toBeDefined();expect(payload).not.toContain('pairingToken');
  });
  it('fences concurrent writers by commit revision rather than independent generations',()=>{
    const shared=temp(),a=temp();const first=owner(a,shared),store=new DaemonRecoveryStore(shared);
    const old=store.load()!;first.order.set('new',2);first.checkpoint.capture();
    expect(()=>store.commit(old,old.payload)).toThrow('recovery_revision_conflict');
    expect(new DaemonRecoveryStore(shared).load()!.revision).toBeGreaterThan(old.revision);
  });
  it('preserves divergent offline files, corrupt databases and unavailable folders',()=>{
    const shared=temp(),a=temp(),b=temp();const first=owner(a,shared);first.checkpoint.capture(true);
    const second=owner(b,shared);second.order.set('b',3);second.checkpoint.capture(true);
    const own=join(a,'daemon-checkpoint.json');const raw=JSON.parse(readFileSync(own,'utf8'));raw.sequence+=10;raw.pocket.feedbackCount+=1;writeFileSync(own,JSON.stringify(raw));
    const original=readFileSync(own,'utf8'),head=new DaemonRecoveryStore(shared).load()!;
    expect(()=>owner(a,shared)).toThrow('recovery_offline_conflict');expect(readFileSync(own,'utf8')).toBe(original);
    expect(new DaemonRecoveryStore(shared).load()).toEqual(head);
    writeFileSync(join(shared,'agentdeck-recovery.sqlite'),'{corrupt');
    expect(()=>new DaemonRecoveryStore(shared).load()).toThrow();expect(readFileSync(join(shared,'agentdeck-recovery.sqlite'),'utf8')).toBe('{corrupt');
    expect(()=>new DaemonRecoveryStore(join(shared,'missing')).load()).toThrow();
  });
  it('retains offline edits if no other owner advanced the recovery head',()=>{
    const shared=temp(),a=temp();const first=owner(a,shared);first.checkpoint.capture(true);
    const data={version:1,pins:{}} as {version:number;pins:Record<string,unknown>};
    data.pins.offline={weight:8,updatedAt:Date.now(),lastSeenAt:Date.now()};writeFileSync(join(a,'session-order.json'),JSON.stringify(data));
    expect(owner(a,shared).order.weightFor('offline')).toBe(8);
  });
  it('resumes a shared commit when the process died before updating its private cursor',()=>{
    const shared=temp(),a=temp();const first=owner(a,shared);
    const cursor=readFileSync(join(a,'daemon-recovery-cursor.json'));
    first.order.set('saved-before-crash',-4);first.checkpoint.capture(true);
    const own=join(a,'daemon-checkpoint.json'),metadata=JSON.parse(readFileSync(own,'utf8'));
    metadata.writer='c2485aa8-a999-4d96-aebc-cbc9a4b1b923';metadata.generation+=1;writeFileSync(own,JSON.stringify(metadata));
    writeFileSync(join(a,'daemon-recovery-cursor.json'),cursor);
    expect(owner(a,shared).order.weightFor('saved-before-crash')).toBe(-4);
  });
  it('refuses a corrupt private cursor instead of treating it as first-time consent',()=>{
    const shared=temp(),a=temp();owner(a,shared);
    const head=new DaemonRecoveryStore(shared).load();
    for(const text of ['', 'null', '[]']) {
      writeFileSync(join(a,'daemon-recovery-cursor.json'),text);
      expect(()=>owner(a,shared)).toThrow();expect(new DaemonRecoveryStore(shared).load()).toEqual(head);
    }
  });
  it('persists explicit location, can disconnect without deleting shared data, and strips unknown checkpoint fields',()=>{
    const shared=temp(),a=temp();const first=owner(a,shared);
    selectRecovery(a,shared);recoveryConsent(shared,true);expect(configuredRecovery(a)).toBeDefined();
    const store=new DaemonRecoveryStore(shared),head=store.load()!;
    const beforeRead=readFileSync(join(shared,'agentdeck-recovery.sqlite'));
    store.load();expect(readFileSync(join(shared,'agentdeck-recovery.sqlite'))).toEqual(beforeRead);
    const raw=JSON.parse(head.payload);raw.secret='never-store';store.commit(head,JSON.stringify(raw));
    expect(store.load()!.payload).not.toContain('never-store');
    recoveryConsent(shared,false);disconnectRecovery(a);expect(configuredRecovery(a)).toBeUndefined();expect(store.load()).not.toBeNull();
    expect(first.configuration.snapshot().pins).toEqual([]);
  });
});

it('preserves both conflict snapshots, refuses a stale preview, and applies each explicit choice once',()=>{
  for(const choice of ['local','recovery'] as const) {
    const shared=temp(),a=temp(),b=temp();const first=owner(a,shared);
    first.order.set('same',1);first.checkpoint.capture(true);
    const second=owner(b,shared);second.order.set('same',7);second.checkpoint.capture(true);
    first.order.set('same',-9);
    const original=readFileSync(join(a,'session-order.json'));
    expect(()=>owner(a,shared)).toThrow('recovery_offline_conflict');
    const sql=new DaemonRecoveryStore(shared),preview=sql.conflicts()[0];expect(preview.runtime).toBe('Node');
    second.order.set('same',8);second.checkpoint.capture(true);
    expect(()=>sql.resolve(preview,choice)).toThrow('recovery_preview_changed');
    expect(readFileSync(join(a,'session-order.json'))).toEqual(original);
    const current=sql.conflicts()[0];sql.resolve(current,choice);
    expect(readFileSync(join(a,'session-order.json'))).toEqual(original);
    const restored=owner(a,shared);expect(restored.order.weightFor('same')).toBe(choice==='local'?-9:8);
    const backups=readdirSync(a).filter(n=>n.startsWith('daemon-recovery-resolution-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(a,backups[0],'session-order.json'))).toEqual(original);
    expect(sql.conflicts()).toEqual([]);
    const other=owner(b,shared);other.order.set('same',12);other.checkpoint.capture(true);
    restored.order.set('same',-9);
    expect(()=>owner(a,shared)).toThrow('recovery_offline_conflict');
  }
});

it('migrates a v1 head without resetting its content or consent',()=>{
  const shared=temp(),a=temp(),legacy=temp();owner(a,shared);
  const head=new DaemonRecoveryStore(shared).load()!;
  const SQLite=createRequire(import.meta.url)('better-sqlite3') as new(path:string)=>{exec(s:string):void;prepare(s:string):{run(...v:unknown[]):void;get():unknown};close():void};
  const db=new SQLite(join(legacy,'agentdeck-recovery.sqlite'));
  db.exec('CREATE TABLE recovery_head(singleton INTEGER PRIMARY KEY,store_id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL); PRAGMA user_version=1;');
  db.prepare('INSERT INTO recovery_head VALUES(1,?,?,?)').run(head.store,head.revision,head.payload);db.close();
  writeFileSync(join(legacy,'recovery-consent.json'),JSON.stringify({version:1,enabled:true,store:head.store}));
  const before=readFileSync(join(legacy,'recovery-consent.json'));
  expect(new DaemonRecoveryStore(legacy).load()).toEqual(head);
  expect(new DaemonRecoveryStore(legacy).conflicts()).toEqual([]);
  expect(readFileSync(join(legacy,'recovery-consent.json'))).toEqual(before);
});
