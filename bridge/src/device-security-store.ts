import { constants, openSync, readSync, fstatSync, closeSync, writeFileSync, fsyncSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEVICE_SECURITY as P, parseDeviceSecurityConfiguration, parseDeviceSecurityTransfer,
  mergeDeviceCredentialState, type DeviceSecurityConfiguration, type DeviceSecurityTransfer } from '@agentdeck/shared';
import { DeviceCredentialStore } from './device-credential-store.js';
import { withCredentialLock } from './pairing-credential-store.js';

/** A replica is never promoted merely because its old owner stopped answering.
 * A fresh seal from the admitted current owner is required. This deliberately
 * prefers unavailable TLS over resurrecting credentials from an old replica. */
export class DeviceSecurityStore {
  readonly credentials:DeviceCredentialStore;
  constructor(readonly directory:string) { this.credentials=new DeviceCredentialStore(directory); }
  read():DeviceSecurityConfiguration|null {
    let fd:number|undefined;
    try {
      fd=openSync(join(this.directory,P.file),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      const stat=fstatSync(fd);if(!stat.isFile()||stat.size>P.maxBytes)throw new Error('invalid-device-security-file');
      const bytes=Buffer.alloc(P.maxBytes+1);let count=0;
      while(count<bytes.length){const n=readSync(fd,bytes,count,bytes.length-count,null);if(!n)break;count+=n;}
      if(count>P.maxBytes)throw new Error('device-security-file-too-large');
      const value=parseDeviceSecurityConfiguration(JSON.parse(bytes.subarray(0,count).toString('utf8')));
      if(!value)throw new Error('invalid-device-security');return value;
    } catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw new Error('device-security-unavailable');}
    finally{if(fd!==undefined)closeSync(fd);}
  }
  private write(value:DeviceSecurityConfiguration):void {
    if(!parseDeviceSecurityConfiguration(value))throw new Error('invalid-device-security');
    const target=join(this.directory,P.file), temp=target+'.'+randomUUID()+'.tmp';let fd:number|undefined;
    try {
      fd=openSync(temp,'wx',0o600);writeFileSync(fd,JSON.stringify(value)+'\n');fsyncSync(fd);closeSync(fd);fd=undefined;
      renameSync(temp,target);
    } catch(error) {
      try{unlinkSync(temp);}catch{/* Preserve the original failure; the temporary file is owner-only. */}
      throw error;
    } finally {if(fd!==undefined)closeSync(fd);}
  }
  /** Installation is a local operator action. Never silently replace a trust root. */
  install(value:unknown):void {
    const configuration=parseDeviceSecurityConfiguration(value);
    if(!configuration||configuration.role!=='owner')throw new Error('invalid-device-security');
    withCredentialLock(this.directory,()=>{if(this.read())throw new Error('device-security-already-configured');this.write(configuration);});
  }
  /** Caller must stop its TLS listener before sealing, and must not restart it. */
  seal(nonce:string):DeviceSecurityTransfer|null {
    if(!/^[a-f0-9]{32}$/.test(nonce))throw new Error('invalid-device-security-nonce');
    return withCredentialLock(this.directory,()=>{
      const configuration=this.read();if(!configuration)return null;
      if(configuration.role!=='owner')throw new Error('device-security-not-owner');
      const credentials=this.credentials.snapshot();
      this.write({...configuration,role:'replica'});
      return {version:1,nonce,configuration,credentials};
    });
  }
  /** Only a freshly sealed response from the admitted current local owner is accepted.
   * Two-phase persistence keeps every incomplete adoption in the inactive role. */
  adopt(raw:unknown,nonce:string):void {
    const transfer=parseDeviceSecurityTransfer(raw,nonce);
    if(!transfer)throw new Error('invalid-device-security-transfer');
    const current=this.credentials.snapshot();
    if(current&&transfer.credentials)mergeDeviceCredentialState(current,transfer.credentials);
    else if(current?.devices.length&&!transfer.credentials)throw new Error('device-security-custody-missing');
    const replica={...transfer.configuration,role:'replica' as const};
    withCredentialLock(this.directory,()=>this.write(replica));
    if(transfer.credentials)this.credentials.adopt(transfer.credentials);
    withCredentialLock(this.directory,()=>{
      if(JSON.stringify(this.read())!==JSON.stringify(replica))throw new Error('device-security-custody-changed');
      this.write(transfer.configuration);
    });
  }
}
