/** Explicitly selected same-machine folder. Never probes another runtime's private container. */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, renameSync, mkdirSync, lstatSync, unlinkSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { DAEMON_RECOVERY_POLICY as P, type DaemonConfiguration } from '@agentdeck/shared';
import { parseDaemonCheckpoint } from './daemon-checkpoint.js';
interface Head { store: string; revision: number; payload: string }
interface Cursor { store: string; revision: number; digest: string }
interface Database {
  pragma(sql: string, options?: {simple: boolean}): unknown;
  exec(sql: string): void;
  prepare(sql: string): {get(): unknown; run(...args: unknown[]): unknown};
  transaction<T>(fn: ()=>T): {immediate(): T};
  close(): void;
}
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';
// Roster maintenance changes lastSeenAt without a user configuration edit.
const selection = (c: DaemonConfiguration|undefined) => c && {...c,pins:c.pins.map(p=>({...p,lastSeenAt:0}))};
function read(path: string): string | null { try { return readFileSync(path,'utf8'); } catch(e) { if(missing(e))return null;throw e; } }
function atomic(path: string, value: unknown): void {
  const tmp=`${path}.${randomUUID()}.tmp`;writeFileSync(tmp,JSON.stringify(value),{mode:0o600});renameSync(tmp,path);
}
function payload(text: string): string {
  const parsed=parseDaemonCheckpoint(text);
  if(!parsed?.configuration)throw new Error('recovery_checkpoint_invalid');
  return JSON.stringify(parsed); // allow-list: never persist unknown source fields
}
function userState(text: string): string {
  const value=parseDaemonCheckpoint(text);if(!value)throw new Error('recovery_checkpoint_invalid');
  return JSON.stringify({pocket:value.pocket,receipts:value.receipts,configuration:selection(value.configuration)},(_k,v)=>
    v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0)):v);
}
export class DaemonRecoveryStore {
  constructor(readonly directory: string) { if(!isAbsolute(directory))throw new Error('recovery_folder_invalid'); }
  private database<T>(body: (db: Database)=>T): T {
    const file=join(this.directory,P.file);
    try { const stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||(process.getuid&&stat.uid!==process.getuid()))throw new Error('recovery_file_invalid'); }
    catch(e){if(!missing(e))throw e;}
    const Database=createRequire(import.meta.url)('better-sqlite3') as new (file: string, options: {timeout: number})=>Database;
    const db=new Database(file,{timeout:P.busyTimeoutMs});
    try {
      const version=db.pragma('user_version',{simple:true});if(version!==0&&version!==P.version)throw new Error('recovery_version_unsupported');
      db.pragma('journal_mode = DELETE');db.pragma('synchronous = FULL');
      if(version===0){db.exec(P.schema);db.pragma(`user_version = ${P.version}`);}
      return body(db);
    } finally { db.close(); }
  }
  load(): Head | null {
    return this.database(db=>{
      const raw=db.prepare('SELECT store_id AS store, revision, payload FROM recovery_head WHERE singleton=1').get() as Head|undefined;
      if(!raw)return null;
      if(!/^[a-f0-9-]{36}$/.test(raw.store)||!Number.isSafeInteger(raw.revision)||raw.revision<1)throw new Error('recovery_head_invalid');
      payload(raw.payload);return raw;
    });
  }
  commit(expected: Head|null, text: string): Head {
    const value=payload(text);
    return this.database(db=>db.transaction(()=>{
      const current=db.prepare('SELECT store_id AS store, revision, payload FROM recovery_head WHERE singleton=1').get() as Head|undefined;
      if(current?.store!==expected?.store||current?.revision!==expected?.revision||current?.payload!==expected?.payload)throw new Error('recovery_revision_conflict');
      if((current?.revision??0)>=P.maxRevision)throw new Error('recovery_revision_exhausted');
      const next={store:current?.store??randomUUID(),revision:(current?.revision??0)+1,payload:value};
      db.prepare('INSERT OR REPLACE INTO recovery_head(singleton,store_id,revision,payload) VALUES(1,?,?,?)').run(next.store,next.revision,next.payload);return next;
    }).immediate());
  }
}
export class DaemonRecoverySession {
  private head: Head|null=null;
  constructor(readonly store: DaemonRecoveryStore,private readonly directory: string) {}
  /** Return true only for a newer, explicitly selected durable recovery head. */
  prepare(configuration?: DaemonConfiguration): boolean {
    this.head=this.store.load();
    const consent=read(join(this.store.directory,P.consentFile));
    if(consent!==null){const marker=JSON.parse(consent);if(marker?.version!==P.version||typeof marker.enabled!=='boolean'||marker.store!==this.head?.store)throw new Error('recovery_consent_invalid');}
    const text=read(join(this.directory,P.cursorFile));const cursor=text===null?null:JSON.parse(text) as Cursor;
    if(text!==null&&(!cursor||typeof cursor!=='object'||Array.isArray(cursor)))throw new Error('recovery_cursor_invalid');
    if(cursor&&(!/^[a-f0-9-]{36}$/.test(cursor.store)||!Number.isSafeInteger(cursor.revision)||cursor.revision<1||!/^[a-f0-9]{64}$/.test(cursor.digest)))throw new Error('recovery_cursor_invalid');
    if(cursor&&(!this.head||cursor.store!==this.head.store||cursor.revision>this.head.revision))throw new Error('recovery_store_changed');
    if(!this.head)return false;
    const peer=read(join(this.directory,'daemon-checkpoint-peer.json'));
    const retirePeer=()=>{
      if(peer===null)return;
      if(payload(peer)!==payload(this.head!.payload))atomic(join(this.directory,`daemon-recovery-peer-profile-${randomUUID()}.json`),JSON.parse(payload(peer)));
      unlinkSync(join(this.directory,'daemon-checkpoint-peer.json'));
    };
    if(cursor?.revision===this.head.revision){retirePeer();return false;}
    const local=read(join(this.directory,'daemon-checkpoint.json'));
    if(cursor&&local&&configuration&&JSON.stringify(selection(configuration))!==JSON.stringify(selection(parseDaemonCheckpoint(local)?.configuration)))throw new Error('recovery_offline_conflict');
    if(cursor&&local&&digest(local)!==cursor.digest&&userState(local)!==userState(this.head.payload))throw new Error('recovery_offline_conflict');
    // A persisted inbox is not a live admission after a receiver was absent.
    // The opted-in transaction log orders compatible owners, including live handover.
    retirePeer();
    atomic(join(this.directory,'daemon-checkpoint-peer.json'),JSON.parse(this.head.payload));return true;
  }
  publish(text: string): void {
    const normalized=payload(text);
    if(!this.head||this.head.payload!==normalized)this.head=this.store.commit(this.head,normalized);
    atomic(join(this.directory,P.cursorFile),{store:this.head.store,revision:this.head.revision,digest:digest(text)} satisfies Cursor);
  }
}
export function configuredRecovery(directory: string): DaemonRecoverySession|undefined {
  let text=read(join(directory,P.locationFile));
  // A later one-time app grant supersedes an older normal-profile disconnect.
  if(text!==null){const prior=JSON.parse(text);if(prior?.version===P.version&&prior.enabled===false)text=null;}
  if(text===null&&process.platform==='darwin'&&process.env.AGENTDECK_DATA_DIR===undefined) {
    const path=join(homedir(),'Library','Application Support',P.folderName);
    const consent=read(join(path,P.consentFile));if(consent===null)return undefined;
    const marker=JSON.parse(consent);
    if(marker?.version===P.version&&marker.enabled===false)return undefined;
    const head=new DaemonRecoveryStore(path).load();
    if(marker?.version!==P.version||marker.enabled!==true||!head||marker.store!==head.store)throw new Error('recovery_consent_invalid');
    text=JSON.stringify({version:P.version,path});
  }
  if(text===null)return undefined;
  const raw=JSON.parse(text);if(raw?.version===P.version&&raw.enabled===false)return undefined;
  if(raw?.version!==P.version||typeof raw.path!=='string')throw new Error('recovery_location_invalid');
  const consent=read(join(raw.path,P.consentFile));
  if(consent!==null&&JSON.parse(consent)?.enabled===false)return undefined;
  return new DaemonRecoverySession(new DaemonRecoveryStore(raw.path),directory);
}
export function selectRecovery(directory: string,path: string): DaemonRecoverySession {
  const session=new DaemonRecoverySession(new DaemonRecoveryStore(path),directory);session.store.load();
  mkdirSync(directory,{recursive:true});atomic(join(directory,P.locationFile),{version:P.version,enabled:true,path});return session;
}
export function disconnectRecovery(directory: string): void { atomic(join(directory,P.locationFile),{version:P.version,enabled:false}); }
export function recoveryConsent(path: string, enabled: boolean): void {
  const head=new DaemonRecoveryStore(path).load();
  if(!head)throw new Error('recovery_head_missing');
  atomic(join(path,P.consentFile),{version:P.version,enabled,store:head.store});
}
