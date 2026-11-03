import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { fenceCredentialResponse } from '../credential-response-fence.js';

describe('HTTP credential generation fence', () => {
  it.each(['end','stream'] as const)('drops a stale %s response instead of exposing the next credential', async kind => {
    let release!:()=>void, started!:()=>void;
    const pending = new Promise<void>(r=>{release=r;});
    const admitted = new Promise<void>(r=>{started=r;});
    let generation=0;
    const server=createServer((_,res)=>{
      const atAdmission=generation;
      fenceCredentialResponse(res,()=>generation===atAdmission);
      started();
      void pending.then(()=>{
        if(kind==='stream')res.write('new-token-secret');
        res.end('new-token-secret');
      });
    });
    await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
    const port=(server.address() as {port:number}).port;
    try {
      const response=fetch(`http://127.0.0.1:${port}`,{signal:AbortSignal.timeout(3000)}).then(r=>r.text()).catch(()=> 'closed');
      await admitted; generation++; release();
      expect(await response).toBe('closed');
    } finally {server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
  });
  it('allows the explicit content-free rotation receipt across a generation change', async()=>{
    let generation=0;
    const server=createServer((_,res)=>{
      const atAdmission=generation;let receipt=false;
      fenceCredentialResponse(res,()=>receipt||generation===atAdmission);
      generation++;receipt=true;res.end(JSON.stringify({rotated:true,globalRevocation:'incomplete'}));
    });
    await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
    try {
      const port=(server.address() as {port:number}).port;
      expect(await (await fetch(`http://127.0.0.1:${port}`,{signal:AbortSignal.timeout(3000)})).json()).toEqual({rotated:true,globalRevocation:'incomplete'});
    } finally {server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
  });
});
