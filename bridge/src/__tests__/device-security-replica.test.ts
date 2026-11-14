import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { DEVICE_SECURITY, type BridgeEvent } from '@agentdeck/shared';
import { DeviceSecurityReplica } from '../device-security-replica.js';
import type { DeviceSecurityManager } from '../device-security-manager.js';
vi.mock('../auth.js',()=>({localPeerOwnership:(pid:number)=>pid===42?'same-user':'unknown'}));
const socket=()=>({readyState:WebSocket.OPEN}) as WebSocket;
const base={type:'state_update'} as BridgeEvent;
function fixture(initial='listening'){
  let state=initial;
  const seal=vi.fn(async(nonce:string)=>{state='replica';return {nonce};});
  const recover=vi.fn(async()=>{state='listening';});
  const manager={status:()=>({state}),sealForHandover:seal,recoverCustody:recover} as unknown as DeviceSecurityManager;
  return {manager,seal,recover};
}
afterEach(()=>vi.useRealTimers());
describe('private device custody receipt',()=>{
  it('recovers after a supervisor restart only from the fresh challenged socket',async()=>{
    const replica=new DeviceSecurityReplica(),{manager,recover}=fixture('replica'),a=socket(),b=socket();
    replica.receive(a,42,DEVICE_SECURITY.subscriptionId);
    const send=vi.fn();replica.requestRecovery(manager,send,base);
    expect(send).toHaveBeenCalledOnce();
    const challenge=JSON.parse(send.mock.calls[0][1].deviceSecurityRecovery);
    await replica.restore(manager,b,42,challenge.nonce,'{}');
    await replica.restore(manager,a,99,challenge.nonce,'{}');
    await replica.restore(manager,a,42,'stale','{}');
    expect(recover).not.toHaveBeenCalled();
    await replica.restore(manager,a,42,challenge.nonce,'{"fresh":true}');
    expect(recover).toHaveBeenCalledWith({fresh:true},challenge.nonce);
    expect(manager.status().state).toBe('listening');
    await replica.restore(manager,a,42,challenge.nonce,'{}');expect(recover).toHaveBeenCalledOnce();
  });
  it('cannot recover an expired or disconnected custody challenge',async()=>{
    vi.useFakeTimers();
    for(const mode of ['expired','disconnected']){
      const replica=new DeviceSecurityReplica(),{manager,recover}=fixture('replica'),a=socket(),send=vi.fn();
      replica.receive(a,42,DEVICE_SECURITY.subscriptionId);replica.requestRecovery(manager,send,base);
      const challenge=JSON.parse(send.mock.calls[0][1].deviceSecurityRecovery);
      if(mode==='expired')await vi.advanceTimersByTimeAsync(DEVICE_SECURITY.bindTimeoutMs);
      else replica.remove(a);
      await replica.restore(manager,a,42,challenge.nonce,'{}');expect(recover).not.toHaveBeenCalled();
      expect(manager.status().state).toBe('replica');
    }
  });
  it('retains ownership without an admitted live same-user successor',async()=>{
    const replica=new DeviceSecurityReplica(),{manager,seal}=fixture(),send=vi.fn();
    replica.receive(socket(),99,DEVICE_SECURITY.subscriptionId);
    await replica.transfer(manager,send,base);
    expect(seal).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();
  });
  it('requires separate readiness and durable receipts from the selected peer',async()=>{
    const replica=new DeviceSecurityReplica(),{manager,seal}=fixture(),a=socket(),b=socket();
    replica.receive(a,42,DEVICE_SECURITY.subscriptionId);replica.receive(b,42,DEVICE_SECURITY.subscriptionId);
    const send=vi.fn();const pending=replica.transfer(manager,send,base);
    const offer=JSON.parse(send.mock.calls[0][1].deviceSecurityTransfer).offer;
    replica.receive(b,42,offer);replica.receive(a,99,offer);replica.receive(a,42,'bad');
    await Promise.resolve();expect(seal).not.toHaveBeenCalled();
    replica.receive(a,42,offer);await Promise.resolve();await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(2);expect(send.mock.calls.every(call=>call[0]===a)).toBe(true);
    const nonce=JSON.parse(send.mock.calls[1][1].deviceSecurityTransfer).transfer.nonce;
    expect(nonce).not.toBe(offer);
    let complete=false;void pending.then(()=>{complete=true;});
    replica.receive(a,42,offer);replica.receive(b,42,nonce);replica.receive(a,99,nonce);
    await Promise.resolve();expect(complete).toBe(false);
    replica.receive(a,42,nonce);await pending;
    expect(seal).toHaveBeenCalledWith(nonce);expect(manager.status().state).toBe('replica');
  });
  it('retains active custody when a subscribed native client is not ready',async()=>{
    vi.useFakeTimers();
    for(const mode of ['timeout','disconnect','throw']){
      const replica=new DeviceSecurityReplica(),{manager,seal}=fixture(),a=socket();
      replica.receive(a,42,DEVICE_SECURITY.subscriptionId);
      const pending=replica.transfer(manager,()=>{if(mode==='throw')throw new Error('closed');},base);
      if(mode==='disconnect')replica.remove(a);
      if(mode==='timeout')await vi.advanceTimersByTimeAsync(DEVICE_SECURITY.offerTimeoutMs);
      await pending;expect(seal).not.toHaveBeenCalled();expect(manager.status().state).toBe('listening');expect(vi.getTimerCount()).toBe(0);
    }
  });
  it('stays sealed when the durable receipt fails after readiness was confirmed',async()=>{
    vi.useFakeTimers();
    for(const mode of ['timeout','disconnect','throw']){
      const replica=new DeviceSecurityReplica(),{manager}=fixture(),a=socket();
      replica.receive(a,42,DEVICE_SECURITY.subscriptionId);
      const pending=replica.transfer(manager,(_socket,event)=>{
        const packet=JSON.parse(event.deviceSecurityTransfer!);
        if(packet.offer){replica.receive(a,42,packet.offer);return;}
        if(mode==='throw')throw new Error('closed');
      },base);
      const rejected=expect(pending).rejects.toThrow('unconfirmed');await vi.advanceTimersByTimeAsync(0);
      if(mode==='disconnect')replica.remove(a);
      if(mode==='timeout')await vi.advanceTimersByTimeAsync(DEVICE_SECURITY.ackTimeoutMs);
      await rejected;expect(manager.status().state).toBe('replica');expect(vi.getTimerCount()).toBe(0);
    }
  });
});
