import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { RelayHub, RelayUplink } from '../daemon-relay.js';
import { SessionSlotManager, type DeckLayout } from '../../../plugin/src/session-slot-manager.js';
import type { SessionInfo } from '@agentdeck/shared';
const SD_PLUS_LAYOUT: DeckLayout = { columns: 4, rows: 2, keyCount: 8, family: 'streamdeckplus' };

const sources = [
 'App/AgentDeckPaths.swift','Model/SessionWeightRules.generated.swift','Model/PairingCodeRules.generated.swift',
 'Daemon/Core/Logger.swift','Daemon/Server/HTTPServer.swift','Daemon/Server/WebSocketServer.swift',
 'Daemon/Server/AuthManager.swift','Daemon/Server/PairingKnockStore.swift','Daemon/Server/LocalTrust.swift','Daemon/Server/LocalTrustRules.generated.swift',
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
  return {child,frames,errors:()=>errors};
 }
 async function freePort(){const s=createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const port=(s.address() as {port:number}).port;await new Promise<void>(r=>s.close(()=>r()));return port;}
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
   await vi.waitFor(()=>expect(process.frames.some(f=>f.event==='ready')).toBe(true),{timeout:6000});
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

});
