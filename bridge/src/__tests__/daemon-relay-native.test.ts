import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { RelayHub, RelayUplink } from '../daemon-relay.js';
import { SessionSlotManager, type DeckLayout } from '../../../plugin/src/session-slot-manager.js';
import { isApprovedPeer, pairingKnocks, recordKnock, resetPairingKnocksForTests } from '../pairing-knocks.js';
import { pairingCredentialGeneration } from '@agentdeck/shared';
import type { SessionInfo } from '@agentdeck/shared';
const SD_PLUS_LAYOUT: DeckLayout = { columns: 4, rows: 2, keyCount: 8, family: 'streamdeckplus' };

const sources = [
 'App/AgentDeckPaths.swift','Model/SessionWeightRules.generated.swift','Model/PairingCodeRules.generated.swift',
 'Daemon/Core/Logger.swift','Daemon/Server/HTTPServer.swift','Daemon/Server/WebSocketServer.swift',
 'Daemon/Server/PairingCredentialRules.generated.swift','Daemon/Server/AuthManager.swift','Daemon/Server/PairingKnockStore.swift','Daemon/Server/LocalTrust.swift','Daemon/Server/LocalTrustRules.generated.swift',
 'Daemon/Session/GitHubCIClient.swift','Daemon/Session/GitHubCIConnection.swift','Daemon/Session/GitHubCIPolicy.generated.swift',
 'Daemon/Relay/DaemonRelayPolicy.generated.swift','Daemon/Relay/DaemonRelay.swift','Daemon/Relay/DaemonRelayConnection.swift','Daemon/Relay/DaemonRelayUplink.swift',
].map(p=>'apple/AgentDeck/'+p);
const TOKEN='0123456789abcdef0123456789abcdef';
describe.skipIf(process.platform!=='darwin')('real mixed Node/Swift relay sockets',()=>{
 let dir:string, binary:string;
 const children:ChildProcess[]=[];
 beforeAll(()=>{
  dir=mkdtempSync(join(tmpdir(),'mixed-relay-'));binary=join(dir,'native');
  execFileSync('xcrun',['swiftc','-swift-version','6','-parse-as-library','-module-cache-path',join(dir,'modules'),...sources,'bridge/src/__tests__/fixtures/daemon-relay-native.swift','-o',binary],{timeout:120_000,stdio:'pipe'});
 },150_000);
 afterAll(()=>{for(const p of children)p.kill('SIGTERM');if(dir)rmSync(dir,{recursive:true,force:true});});
 function native(mode:string,port:number){
  const data=mkdtempSync(join(dir,'data-'));writeFileSync(join(data,'auth-token'),TOKEN+'\n');
  const child=spawn(binary,[mode,String(port)],{env:{...process.env,AGENTDECK_DATA_DIR:data},stdio:['pipe','pipe','pipe']});children.push(child);
  const frames:Record<string,any>[]=[];let buffer='';let errors='';
  child.stderr!.on('data',b=>{errors+=b.toString();});
  child.stdout!.on('data',b=>{buffer+=b.toString();for(let n;(n=buffer.indexOf('\n'))>=0;){const line=buffer.slice(0,n);buffer=buffer.slice(n+1);try{frames.push(JSON.parse(line));}catch{ /* native logs */ }}});
  return {child,frames,dataDir:data,errors:()=>errors};
 }
 async function freePort(){const s=createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const port=(s.address() as {port:number}).port;await new Promise<void>(r=>s.close(()=>r()));return port;}
 async function waitForReady(process:ReturnType<typeof native>){
  await vi.waitFor(()=>expect(process.frames.some(f=>f.event==='ready'),
   `Native fixture did not become ready (exit=${process.child.exitCode}, signal=${process.child.signalCode}): ${process.errors()}`
  ).toBe(true),{timeout:6000});
 }
 it('Swift worker publishes to Node hub, reconnects once without duplicates, and refuses unsupported commands',async()=>{
  const http=createServer((_,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({mode:'daemon',daemonRelay:true}));});
  const wss=new WebSocketServer({server:http});const hub=new RelayHub({instanceId:'node-hub',onChange:()=>{}});let peer:WebSocket|undefined;let refusals=0,pings=0;
  wss.on('connection',ws=>{peer=ws;ws.on('ping',()=>pings++);ws.on('message',raw=>{const msg=JSON.parse(raw.toString());if(msg.type==='relay_command_refused')refusals++;hub.handleFrame(msg,ws);});ws.on('close',()=>hub.dropSocket(ws));});
  await new Promise<void>(r=>http.listen(0,'127.0.0.1',r));const port=(http.address() as {port:number}).port;
  const process=native('worker',port);
  try {
   await vi.waitFor(()=>expect(hub.rows()).toHaveLength(1),{timeout:6000});
   expect(hub.rows()[0]).toMatchObject({id:'observed:claude:native',port:0,stopRequested:false,waitingOn:null});
   peer!.send(JSON.stringify({type:'relay_command_down',command:{type:'voice'}}));
   hub.route({type:'permission_decision',requestId:'native-held-gate',decision:'allow'} as never,null,String);
   await vi.waitFor(()=>{expect(refusals).toBe(1);expect(process.frames.some(f=>f.event==='executed'&&f.command.requestId==='native-held-gate')).toBe(true);},{timeout:3000});
   await vi.waitFor(()=>expect(pings).toBeGreaterThan(0),{timeout:18000});
   const prior=peer;peer!.terminate();
   await vi.waitFor(()=>{expect(peer).not.toBe(prior);expect(hub.rows()).toHaveLength(1);},{timeout:6000});
   expect(hub.summary()).toHaveLength(1);
  } finally {process.child.kill('SIGTERM');for(const ws of wss.clients)ws.terminate();await new Promise<void>(r=>wss.close(()=>r()));await new Promise<void>(r=>http.close(()=>r()));}
 },30_000);
 it('renders held questions as original choices and returns their selected index through the real Swift worker',async()=>{
  const http=createServer((_,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({mode:'daemon',daemonRelay:true}));});
  const wss=new WebSocketServer({server:http});const hub=new RelayHub({instanceId:'question-hub',onChange:()=>{}});
  const publications:Record<string,any>[]=[];
  wss.on('connection',ws=>{ws.on('message',raw=>{const msg=JSON.parse(raw.toString());if(msg.type==='relay_sessions')publications.push(msg);hub.handleFrame(msg,ws);});ws.on('close',()=>hub.dropSocket(ws));});
  await new Promise<void>(r=>http.listen(0,'127.0.0.1',r));
  const process=native('worker-ask',(http.address() as {port:number}).port);
  try {
   await vi.waitFor(()=>expect(hub.rows()).toHaveLength(1),{timeout:6000});
   const row=hub.rows()[0];
   expect(row).not.toHaveProperty('requestId');
   expect(publications[0].sessions[0]).not.toHaveProperty('_relayHeldAsk');
   const manager=new SessionSlotManager();manager.updateSessions([row as SessionInfo]);manager.enterDetailView(row.id);
   const cells=Array.from({length:SD_PLUS_LAYOUT.keyCount},(_,slot)=>manager.getSlotConfig(slot,SD_PLUS_LAYOUT));
   expect(cells.filter(cell=>cell.type==='option').map(cell=>cell.option?.label)).toEqual(['Alpha','Bravo','Charlie']);
   const selected=cells.findIndex(cell=>cell.optionIndex===2);
   expect(manager.handleSlotPress(selected,SD_PLUS_LAYOUT)).toMatchObject({action:'select-option',optionIndex:2});
   expect(hub.route({type:'select_option',sessionId:row.id,index:2,question:'Which path?'} as never,null,String)).toBe(true);
   await vi.waitFor(()=>expect(process.frames).toContainEqual({event:'executed',command:{type:'session_command',sessionId:row.id,command:{type:'select_option',index:2,question:'Which path?'}}}),{timeout:3000});
  } finally {process.child.kill('SIGTERM');for(const ws of wss.clients)ws.terminate();await new Promise<void>(r=>wss.close(()=>r()));await new Promise<void>(r=>http.close(()=>r()));}
 },20_000);
 it('Node worker publishes to Swift hub and receives same-socket controls; real native WS rejects missing/wrong token for a browser-origin peer',async()=>{
  const port=await freePort(),process=native('hub',port);
  let uplink:RelayUplink|undefined;const executed:unknown[]=[];
  try {
   await waitForReady(process);
   for(const token of ['', 'wrong']) {
    const status=await new Promise<number>((resolve,reject)=>{const ws=new WebSocket(`ws://127.0.0.1:${port}?token=${token}`,{origin:'https://untrusted.example',handshakeTimeout:2000});ws.on('unexpected-response',(_,res)=>{resolve(res.statusCode!);ws.terminate();});ws.on('error',()=>{});ws.on('open',()=>{ws.close();reject(new Error('unauthenticated relay upgraded'));});});
    expect(status).toBe(401);
   }
   const paired=new WebSocket(`ws://127.0.0.1:${port}?token=${TOKEN}`,{origin:'https://untrusted.example',handshakeTimeout:2000});
   await new Promise<void>((resolve,reject)=>{paired.once('open',()=>resolve());paired.once('error',reject);});paired.close();
   uplink=new RelayUplink({target:{host:'127.0.0.1',port},instanceId:'node-worker',hostLabel:'node',snapshot:async()=>[{id:'observed:claude:node',agentType:'claude-code',controlMode:'observed',projectName:'fixture',state:'processing',port:0,alive:true}] as never,execute:cmd=>executed.push(cmd),probeHealth:async()=>{const response=await fetch(`http://127.0.0.1:${port}/health`);return await response.json();},log:()=>{}});
   uplink.start();await vi.waitFor(()=>expect(process.frames.some(f=>f.event==='roster'&&f.sessions?.some((s:any)=>s.id==='observed:claude:node'))).toBe(true),{timeout:6000});
   process.child.stdin!.write(JSON.stringify({type:'session_command',sessionId:'observed:claude:node',command:{type:'interrupt'}})+'\n');
   await vi.waitFor(()=>expect(executed).toEqual([{type:'session_command',sessionId:'observed:claude:node',command:{type:'interrupt'}}]),{timeout:3000});
  } finally {uplink?.stop();process.child.kill('SIGTERM');}
 },20_000);
 it('Swift refuses a wrong-version ack and tears down a hub that never acknowledges hello',async()=>{
  for(const wrongVersion of [true,false]) {
   const http=createServer((_,res)=>res.end(JSON.stringify({mode:'daemon',daemonRelay:true})));
   const wss=new WebSocketServer({server:http});let connected=0,closed=0,published=0;
   wss.on('connection',ws=>{connected++;ws.on('close',()=>closed++);ws.on('message',raw=>{const msg=JSON.parse(raw.toString());if(msg.type==='relay_hello'&&wrongVersion)ws.send(JSON.stringify({type:'relay_ack',v:2}));if(msg.type==='relay_sessions')published++;});});
   await new Promise<void>(r=>http.listen(0,'127.0.0.1',r));const process=native('worker',(http.address() as {port:number}).port);
   try {await vi.waitFor(()=>{expect(connected).toBeGreaterThan(0);expect(closed).toBeGreaterThan(0);},{timeout:wrongVersion?4000:13000});expect(published).toBe(0);}
   finally {process.child.kill('SIGTERM');for(const ws of wss.clients)ws.terminate();await new Promise<void>(r=>wss.close(()=>r()));await new Promise<void>(r=>http.close(()=>r()));}
  }
 },20_000);

 it('flushes a native retirement receipt before disconnecting upgraded and HTTP stream sockets',async()=>{
  const port=await freePort(),process=native('retirement',port);
  let ws:WebSocket|undefined;
  try {
   await waitForReady(process);
   const held=connect(port,'127.0.0.1');
   try {
    let data='';held.on('data',chunk=>{data+=chunk.toString();});
    await new Promise<void>((resolve,reject)=>{held.once('connect',resolve);held.once('error',reject);});
    held.write('GET /held-stream HTTP/1.1\r\nHost: localhost:'+port+'\r\n\r\n');
    await vi.waitFor(()=>expect(data).toContain('data: ready'),{timeout:3000});
    ws=new WebSocket(`ws://127.0.0.1:${port}?token=${TOKEN}`,{handshakeTimeout:2000});
    await new Promise<void>((resolve,reject)=>{ws!.once('open',resolve);ws!.once('error',reject);});
    const closed=new Promise<void>(resolve=>ws!.once('close',()=>resolve()));
    const receipt=await fetch(`http://127.0.0.1:${port}/retire-sockets`,{method:'POST',signal:AbortSignal.timeout(3000)});
    expect(await receipt.json()).toEqual({retired:true});
    await closed;
    await vi.waitFor(()=>expect(held.destroyed).toBe(true),{timeout:3000});
   } finally {held.destroy();}
  } finally {ws?.terminate();process.child.kill('SIGTERM');}
 },15_000);

 it('fences old native approvals, delayed HTTP replies and WebSocket sends/commands across successive retirements',async()=>{
  const port=await freePort(),process=native('generation',port);
  try {
   await waitForReady(process);
   const request=(path:string,method='GET')=>fetch(`http://127.0.0.1:${port}${path}`,{method,signal:AbortSignal.timeout(4000)});
   for(let revision=1;revision<=2;revision++) {
    await request('/approve','POST');
    expect(await (await request('/approval')).json()).toEqual({approved:true});
    expect(await (await request('/knock','POST')).json()).toEqual({knocks:0});
    const previousDir=globalThis.process.env.AGENTDECK_DATA_DIR;
    try {
     globalThis.process.env.AGENTDECK_DATA_DIR=process.dataDir;resetPairingKnocksForTests();
     const stateFile=join(process.dataDir,'auth-credentials.json');
     const generation=existsSync(stateFile)?pairingCredentialGeneration(JSON.parse(readFileSync(stateFile,'utf8'))):undefined;
     expect(isApprovedPeer('192.0.2.1','a'.repeat(32),generation)).toBe(true);
    } finally {if(previousDir===undefined)delete globalThis.process.env.AGENTDECK_DATA_DIR;else globalThis.process.env.AGENTDECK_DATA_DIR=previousDir;resetPairingKnocksForTests();}
    const ws=new WebSocket(`ws://127.0.0.1:${port}`,{handshakeTimeout:2000});
    const input=new WebSocket(`ws://127.0.0.1:${port}`,{handshakeTimeout:2000});
    const frames:string[]=[];ws.on('message',data=>frames.push(data.toString()));
    try {
     await new Promise<void>((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
     if(input.readyState!==WebSocket.OPEN)await new Promise<void>((resolve,reject)=>{input.once('open',resolve);input.once('error',reject);});
     const closed=new Promise<void>(resolve=>ws.once('close',()=>resolve()));
     const inputClosed=new Promise<void>(resolve=>input.once('close',()=>resolve()));
     const pending=request('/slow-secret').then(r=>r.text()).catch(()=> 'closed');
     await vi.waitFor(()=>expect(process.frames.filter(f=>f.event==='slow-started')).toHaveLength(revision),{timeout:3000});
     expect(await (await request('/advance','POST')).json()).toEqual({advanced:true});
     expect(await (await request('/approval')).json()).toEqual({approved:false});
     expect(await (await request('/knock','POST')).json()).toEqual({knocks:1});
     const previousDir=globalThis.process.env.AGENTDECK_DATA_DIR;
     try {
      globalThis.process.env.AGENTDECK_DATA_DIR=process.dataDir;resetPairingKnocksForTests();
      const generation=pairingCredentialGeneration(JSON.parse(readFileSync(join(process.dataDir,'auth-credentials.json'),'utf8')));
      recordKnock('192.0.2.1','a'.repeat(32),true,Date.now(),generation);
      expect(pairingKnocks()).toMatchObject([{key:'device:'+'a'.repeat(32),staleToken:true}]);
      expect(isApprovedPeer('192.0.2.1','a'.repeat(32),generation)).toBe(false);
     } finally {if(previousDir===undefined)delete globalThis.process.env.AGENTDECK_DATA_DIR;else globalThis.process.env.AGENTDECK_DATA_DIR=previousDir;resetPairingKnocksForTests();}
     input.send(JSON.stringify({type:'retired-command-probe'}));
     await inputClosed;
     expect(process.frames.filter(f=>f.event==='generation-command-received')).toEqual([]);
     await request('/publish','POST');
     await closed;
     expect(frames).toEqual([]);
     expect(await pending).toBe('closed');
    } finally {ws.terminate();input.terminate();}
   }
  } finally {process.child.kill('SIGTERM');}
 },20_000);

});
