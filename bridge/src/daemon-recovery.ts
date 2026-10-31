/** Explicitly selected same-machine folder. Never probes another runtime's private container. */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, renameSync, mkdirSync, lstatSync, unlinkSync, copyFileSync, existsSync } from 'node:fs';
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
  prepare(sql: string): {get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[]; run(...args: unknown[]): unknown};
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
      const version=db.pragma('user_version',{simple:true});if(version!==0&&version!==1&&version!==P.schemaVersion)throw new Error('recovery_version_unsupported');
      db.pragma('journal_mode = DELETE');db.pragma('synchronous = FULL');
      if(version<P.schemaVersion)db.transaction(()=>{db.exec(P.schema);db.pragma(`user_version = ${P.schemaVersion}`);}).immediate();
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
  conflicts(): Array<{profile:string;runtime:string;localDigest:string;snapshot:string;store:string;revision:number;headDigest:string;recovered:string}> {
    const head=this.load();if(!head)return [];
    return this.database(db=>db.prepare('SELECT profile,runtime,local_digest AS localDigest,snapshot FROM recovery_conflicts').all().map(raw=>{
      const row=raw as {profile:string;runtime:string;localDigest:string;snapshot:string};payload(row.snapshot);
      return {...row,store:head.store,revision:head.revision,headDigest:digest(head.payload),recovered:head.payload};
    }));
  }
  resolve(expected: {profile:string;localDigest:string;store:string;revision:number;headDigest:string},choice:'local'|'recovery'): void {
    this.database(db=>db.transaction(()=>{
      const head=db.prepare('SELECT store_id AS store, revision, payload FROM recovery_head WHERE singleton=1').get() as Head|undefined;
      const row=db.prepare('SELECT local_digest AS localDigest,snapshot FROM recovery_conflicts WHERE profile=?').get(expected.profile) as {localDigest:string;snapshot:string}|undefined;
      if(!head||!row||head.store!==expected.store||head.revision!==expected.revision||digest(head.payload)!==expected.headDigest||row.localDigest!==expected.localDigest)throw new Error('recovery_preview_changed');
      if(head.revision>=P.maxRevision||!['local','recovery'].includes(choice))throw new Error('recovery_choice_invalid');
      const selected=payload(choice==='local'?row.snapshot:head.payload),revision=head.revision+1;
      db.prepare('UPDATE recovery_resolutions SET applied=1 WHERE profile=? AND applied=0').run(expected.profile);
      db.prepare('INSERT INTO recovery_resolutions(id,store_id,profile,local_digest,revision,choice,local_payload,prior_payload) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),head.store,expected.profile,row.localDigest,revision,choice,payload(row.snapshot),payload(head.payload));
      db.prepare('UPDATE recovery_head SET revision=?,payload=? WHERE singleton=1').run(revision,selected);
    }).immediate());
  }
  report(profile: string, runtime: string, snapshot: string): void {
    const normalized=payload(snapshot), localDigest=digest(userState(normalized));
    this.database(db=>db.transaction(()=>{
      const known=db.prepare('SELECT profile FROM recovery_conflicts WHERE profile=?').get(profile);
      const count=db.prepare('SELECT COUNT(*) AS count FROM recovery_conflicts').get() as {count:number};
      if(!known&&count.count>=P.maxConflicts)throw new Error('recovery_conflict_limit');
      db.prepare('INSERT OR REPLACE INTO recovery_conflicts(profile,runtime,local_digest,snapshot) VALUES(?,?,?,?)').run(profile,runtime,localDigest,normalized);
    }).immediate());
  }
  approved(profile: string, localDigest: string): {id:string;revision:number}|undefined {
    const row=this.database(db=>db.prepare('SELECT r.id,r.revision FROM recovery_resolutions r JOIN recovery_head h ON h.singleton=1 AND r.store_id=h.store_id WHERE r.profile=? AND r.local_digest=? AND r.applied=0 AND r.revision<=h.revision ORDER BY r.revision DESC LIMIT 1').get(profile,localDigest) as {id:string;revision:number}|undefined);
    if(row&&(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(row.id)||!Number.isSafeInteger(row.revision)||row.revision<1))throw new Error('recovery_resolution_invalid');
    return row;
  }
  acknowledge(id: string, profile: string, localDigest: string): void {
    this.database(db=>db.transaction(()=>{
      db.prepare('UPDATE recovery_resolutions SET applied=1 WHERE id=?').run(id);
      db.prepare('DELETE FROM recovery_conflicts WHERE profile=? AND local_digest=?').run(profile,localDigest);
    }).immediate());
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
  private approval: {id:string;digest:string}|undefined;
  private get profile(): string { return digest(`node\n${this.directory}`); }
  constructor(readonly store: DaemonRecoveryStore,private readonly directory: string) {}
  /** Return true only for a newer, explicitly selected durable recovery head. */
  prepare(configuration?: DaemonConfiguration): boolean {
    this.head=this.store.load();
    const consent=read(join(this.store.directory,P.consentFile));
    if(consent!==null){const marker=JSON.parse(consent);if(marker?.version!==P.version||typeof marker.enabled!=='boolean'||marker.store!==this.head?.store)throw new Error('recovery_consent_invalid');}
    const text=read(join(this.directory,P.cursorFile));const cursor=text===null?null:JSON.parse(text) as Cursor;
    if(text!==null&&(!cursor||typeof cursor!=='object'||Array.isArray(cursor)))throw new Error('recovery_cursor_invalid');
    if(cursor&&(!/^[a-f0-9-]{36}$/.test(cursor.store)||!Number.isSafeInteger(cursor.revision)||cursor.revision<1||!/^[a-f0-9]{64}$/.test(cursor.digest)))throw new Error('recovery_cursor_invalid');
    const local=read(join(this.directory,'daemon-checkpoint.json'));
    const candidate=local?parseDaemonCheckpoint(local):null;
    if(candidate&&configuration)candidate.configuration=configuration;
    const candidateText=candidate?JSON.stringify(candidate):null;
    const localDigest=candidateText?digest(userState(candidateText)):null;
    const approved=localDigest?this.store.approved(this.profile,localDigest):undefined;
    if(approved&&this.head&&approved.revision<=this.head.revision) {
      const backup=join(this.directory,`daemon-recovery-resolution-${approved.id}`);
      if(!existsSync(backup)) {
        mkdirSync(backup,{mode:0o700});
        for(const name of P.preservedFiles)if(existsSync(join(this.directory,name)))copyFileSync(join(this.directory,name),join(backup,name));
      }
      this.approval={id:approved.id,digest:localDigest!};
      atomic(join(this.directory,'daemon-checkpoint-peer.json'),JSON.parse(this.head.payload));return true;
    }
    const conflict=(reason:string):never=>{if(candidateText&&this.head)this.store.report(this.profile,'Node',candidateText);throw new Error(reason);};
    if(cursor&&(!this.head||cursor.store!==this.head.store||cursor.revision>this.head.revision))conflict('recovery_store_changed');
    if(!this.head)return false;
    const peer=read(join(this.directory,'daemon-checkpoint-peer.json'));
    const retirePeer=()=>{
      if(peer===null)return;
      if(payload(peer)!==payload(this.head!.payload))atomic(join(this.directory,`daemon-recovery-peer-profile-${randomUUID()}.json`),JSON.parse(payload(peer)));
      unlinkSync(join(this.directory,'daemon-checkpoint-peer.json'));
    };
    if(cursor?.revision===this.head.revision){retirePeer();return false;}
    if(cursor&&local&&configuration&&JSON.stringify(selection(configuration))!==JSON.stringify(selection(parseDaemonCheckpoint(local)?.configuration)))conflict('recovery_offline_conflict');
    if(cursor&&local&&digest(local)!==cursor.digest&&userState(local)!==userState(this.head.payload))conflict('recovery_offline_conflict');
    // A persisted inbox is not a live admission after a receiver was absent.
    // The opted-in transaction log orders compatible owners, including live handover.
    retirePeer();
    atomic(join(this.directory,'daemon-checkpoint-peer.json'),JSON.parse(this.head.payload));return true;
  }
  publish(text: string): void {
    const normalized=payload(text);
    if(!this.head||this.head.payload!==normalized)this.head=this.store.commit(this.head,normalized);
    atomic(join(this.directory,P.cursorFile),{store:this.head.store,revision:this.head.revision,digest:digest(text)} satisfies Cursor);
    if(this.approval){this.store.acknowledge(this.approval.id,this.profile,this.approval.digest);this.approval=undefined;}
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
