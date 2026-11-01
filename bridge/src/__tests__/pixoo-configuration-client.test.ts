import { afterEach, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadPixooEditTarget, savePixooEditTarget } from '../pixoo/pixoo-configuration-client.js';
const prior = process.env.AGENTDECK_DATA_DIR;
let directory: string;
afterEach(()=>{ if(prior===undefined)delete process.env.AGENTDECK_DATA_DIR;else process.env.AGENTDECK_DATA_DIR=prior; if(directory)rmSync(directory,{recursive:true,force:true}); });
it('uses the active owner and never writes the inactive profile on stale or unsupported responses', async () => {
  directory=mkdtempSync(join(tmpdir(),'pixoo-editor-'));process.env.AGENTDECK_DATA_DIR=directory;
  writeFileSync(join(directory,'settings.json'),'{"private":"preserve"}');
  let revision='first',supported=true;
  let configuration={devices:[] as Array<{ip:string;brightness:number;animation:'tide'}>,autoDiscover:false};
  const server=createServer((req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(req.url==='/health'){res.end(JSON.stringify({mode:'daemon',pid:process.pid,isSwift:true}));return;}
    if(!supported){res.writeHead(404);res.end('{}');return;}
    if(req.method==='GET'){res.end(JSON.stringify({configuration,revision}));return;}
    let raw='';req.on('data',d=>raw+=d);req.on('end',()=>{
      const body=JSON.parse(raw);
      if(body.revision!==revision){res.writeHead(409);res.end('{}');return;}
      configuration=body.configuration;revision='second';res.end(JSON.stringify({configuration,revision}));
    });
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const port=String((server.address() as {port:number}).port), target=await loadPixooEditTarget(port);
    const next={devices:[{ip:'127.0.0.2',brightness:27,animation:'tide' as const}],autoDiscover:false};
    await savePixooEditTarget(target,next);expect(configuration).toEqual(next);
    await expect(savePixooEditTarget(target,{devices:[],autoDiscover:false})).rejects.toThrow('409');
    supported=false;await expect(loadPixooEditTarget(port)).rejects.toThrow('unavailable');
    expect(readFileSync(join(directory,'settings.json'),'utf8')).toBe('{"private":"preserve"}');
  } finally { await new Promise<void>(resolve=>server.close(()=>resolve())); }
});
