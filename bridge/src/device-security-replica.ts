import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { DEVICE_SECURITY, DEVICE_CREDENTIALS, type BridgeEvent } from '@agentdeck/shared';
import { localPeerOwnership } from './auth.js';
import { DeviceSecurityManager } from './device-security-manager.js';

/** One admitted local native successor, never a device broadcast or remote relay. */
export class DeviceSecurityReplica {
  private peers=new Map<WebSocket,number>();
  private recovery=new Map<WebSocket,{pid:number;nonce:string;expiresAt:number}>();
  private pending:{socket:WebSocket;pid:number;nonce:string;ack:()=>void;fail:()=>void}|null=null;
  receive(socket:WebSocket,pid:number,nonce:string):void{
    if(!Number.isInteger(pid)||localPeerOwnership(pid)!=='same-user')return;
    if(nonce===DEVICE_SECURITY.subscriptionId){this.peers.set(socket,pid);return;}
    const pending=this.pending;
    if(pending?.socket===socket&&pending.pid===pid&&pending.nonce===nonce)pending.ack();
  }
  remove(socket:WebSocket):void{
    this.peers.delete(socket);
    this.recovery.delete(socket);
    if(this.pending?.socket===socket)this.pending.fail();
  }
  requestRecovery(manager:DeviceSecurityManager,send:(socket:WebSocket,event:BridgeEvent)=>void,base:BridgeEvent):void{
    if(manager.status().state!=='replica')return;
    for(const [socket,pid] of this.peers){
      if(socket.readyState!==WebSocket.OPEN||localPeerOwnership(pid)!=='same-user')continue;
      const prior=this.recovery.get(socket);
      if(prior&&prior.expiresAt>Date.now())continue;
      const challenge={pid,nonce:randomBytes(16).toString('hex'),expiresAt:Date.now()+DEVICE_SECURITY.bindTimeoutMs};
      this.recovery.set(socket,challenge);
      send(socket,{...base,deviceSecurityRecovery:JSON.stringify({...challenge,pid:process.pid})} as BridgeEvent);
    }
  }
  async restore(manager:DeviceSecurityManager,socket:WebSocket,pid:number,nonce:string,transfer:string):Promise<void>{
    const challenge=this.recovery.get(socket);
    if(!challenge||challenge.pid!==pid||challenge.nonce!==nonce||challenge.expiresAt<=Date.now()
      ||localPeerOwnership(pid)!=='same-user'||manager.status().state!=='replica')return;
    this.recovery.delete(socket);
    if(Buffer.byteLength(transfer)>DEVICE_SECURITY.maxBytes+DEVICE_CREDENTIALS.maxBytes)throw new Error('device-security-transfer-too-large');
    await manager.recoverCustody(JSON.parse(transfer),nonce);
    this.recovery.clear();
  }
  async transfer(manager:DeviceSecurityManager,send:(socket:WebSocket,event:BridgeEvent)=>void,base:BridgeEvent):Promise<void>{
    if(manager.status().state!=='listening')return;
    const selected=[...this.peers].find(([socket,pid])=>socket.readyState===WebSocket.OPEN&&localPeerOwnership(pid)==='same-user');
    if(!selected)return; // Retain the durable owner state for its own restart.
    const [socket,pid]=selected;
    // A subscribed UI socket may connect before native ownership reaches client
    // mode. Confirm readiness before sealing; silence retains our owner state.
    const offer=randomBytes(16).toString('hex');
    try {
      await this.receipt(socket,pid,offer,DEVICE_SECURITY.offerTimeoutMs,()=>send(socket,
        {...base,deviceSecurityTransfer:JSON.stringify({pid:process.pid,offer})} as BridgeEvent));
    } catch { return; }
    if(socket.readyState!==WebSocket.OPEN||localPeerOwnership(pid)!=='same-user')return;
    const nonce=randomBytes(16).toString('hex');
    const receipt=await manager.sealForHandover(nonce);
    if(!receipt)return;
    await this.receipt(socket,pid,nonce,DEVICE_SECURITY.ackTimeoutMs,()=>send(socket,
      {...base,deviceSecurityTransfer:JSON.stringify({pid:process.pid,transfer:receipt})} as BridgeEvent));
  }
  private receipt(socket:WebSocket,pid:number,nonce:string,timeout:number,send:()=>void):Promise<void>{
    return new Promise<void>((resolve,reject)=>{
      const fail=()=>{clearTimeout(timer);this.pending=null;reject(new Error('device-security-replica-unconfirmed'));};
      const timer=setTimeout(fail,timeout);
      this.pending={socket,pid,nonce,fail,ack:()=>{clearTimeout(timer);this.pending=null;resolve();}};
      try { send(); } catch { fail(); }
    });
  }
}
