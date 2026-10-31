#!/usr/bin/env node
/** Opt-in developer acceptance: actual signed app + real isolated CLI processes.
 * Never run against production 9120, an installed app, real sources or hardware.
 * Build/sign the alternate-bundle app and bootstrap its typed preferences first.
 */
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, openSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { createServer } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('..', import.meta.url));
const { WebSocket } = createRequire(new URL('../bridge/package.json', import.meta.url))('ws');
const args = process.argv.slice(2);
if (!args.includes('--allow-visible-fixtures')) throw new Error('Requires --allow-visible-fixtures and a prepared alternate signed app.');
const arg = name => { const i=args.indexOf(name); assert(i>=0 && args[i+1], `Missing ${name}`); return args[i+1]; };
const app=resolve(arg('--app')), swiftData=resolve(arg('--swift-data')), out=resolve(arg('--out'));
const sleepMode=args.includes('--sleep-mode')?arg('--sleep-mode'):null;
assert(sleepMode===null||['swift','node','both'].includes(sleepMode),'Invalid sleep mode');
if(args.includes('--sleep-now'))assert(sleepMode&&args.includes('--dedicated-sleep-host'),'Actual sleep requires --dedicated-sleep-host and a sleep mode');
const temporaryRoot='/private/tmp/agentdeck-lifecycle-acceptance';
assert.equal(process.platform,'darwin');
assert(app.startsWith(temporaryRoot+'/') && !app.includes('/Applications/'));
assert(swiftData.includes('/Containers/bound.serendipity.agent.deck.lifecycle-audit/'));
const executable=join(app,'Contents/MacOS/AgentDeck');
const info=JSON.parse(execFileSync('plutil',['-convert','json','-o','-',join(app,'Contents/Info.plist')],{encoding:'utf8'}));
assert.equal(info.CFBundleIdentifier,'bound.serendipity.agent.deck.lifecycle-audit');
execFileSync('codesign',['--verify','--deep','--strict',app]);
const ent=execFileSync('codesign',['-d','--entitlements',':-',app],{encoding:'utf8',stdio:['ignore','pipe','ignore']});
assert.match(ent,/<key>com.apple.security.app-sandbox<\/key>\s*<true\/>/);
const lo=19450,hi=19459,port=lo,window=`${lo}-${hi}`;
mkdirSync(out,{recursive:true});
writeFileSync(join(out,'artifact.json'),JSON.stringify({
  bundleID:info.CFBundleIdentifier,version:info.CFBundleShortVersionString,build:info.CFBundleVersion,
  executableSHA256:createHash('sha256').update(readFileSync(executable)).digest('hex'),
  debugDylibPresent:existsSync(join(app,'Contents/MacOS/AgentDeck.debug.dylib')),
  signatureVerified:true,sandbox:true,node:process.version,portWindow:[lo,hi]
},null,2));
const nodeData=join(temporaryRoot,sleepMode?'node-data-sleep-'+sleepMode:'node-data'), home=join(temporaryRoot,'node-home'), bin=join(temporaryRoot,'bin');
for(const p of [nodeData,home,bin]) mkdirSync(p,{recursive:true});
writeFileSync(join(bin,'security'),'#!/bin/sh\nexit 44\n',{mode:0o700});
writeFileSync(join(nodeData,'settings.json'),JSON.stringify({apme:{enabled:false,judge:{sampleRate:0}},llm:{mlx:{endpoint:'http://127.0.0.1:19459'}}}));
const nodeEnv={PATH:`${bin}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,HOME:home,TMPDIR:temporaryRoot,
  AGENTDECK_DATA_DIR:nodeData,AGENTDECK_PORT_WINDOW:window,AGENTDECK_DAEMON_NO_SERIAL:'1',
  AGENTDECK_DAEMON_NO_GATEWAY:'1',AGENTDECK_CODEX_LIVE_USAGE:'0',AGENTDECK_CLAUDE_USAGE_RECOVERY:'0'};
const cli=join(root,'bridge/dist/cli.js');
const owned=new Set(), reports=[], observations=[]; let step=0;
const runID=Date.now().toString(36);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const hash=value=>{assert(typeof value==='string'&&value.length>0,'Missing token/marker input');return createHash('sha256').update(value).digest('hex');};
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
function processCommand(pid) {
  try{return execFileSync('ps',['eww','-p',String(pid),'-o','command='],{encoding:'utf8'});}
  catch{throw new Error('Process identity inspection unavailable');} // Never log a partial environment.
}
function appPID() {
  const rows=execFileSync('ps',['-axo','pid=,comm='],{encoding:'utf8'}).split('\n');
  const matches=rows.map(r=>/^\s*(\d+)\s+(.+)$/.exec(r)).filter(m=>m?.[2]===executable).map(m=>Number(m[1]));
  assert(matches.length<=1,'Unexpected multiple test apps'); return matches[0];
}
async function until(label,fn,ms=30_000) {
  const end=Date.now()+ms;while(Date.now()<end){const value=await fn();if(value)return value;await delay(150);}
  throw new Error(`Timed out: ${label}`);
}
async function request(p,path,body) {
  assert(p>=lo && p<=hi,'Refusing a request outside the private window');
  const r=await fetch(`http://127.0.0.1:${p}${path}`,{method:body===undefined?'GET':'POST',
    headers:{'Content-Type':'application/json','X-AgentDeck-Pid':String(process.pid)},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(2500)});
  assert(r.ok,`${path}: ${r.status}`);return r.json();
}
async function health(p=port) {try{return await request(p,'/health');}catch{return null;}}
function register(h) {
  assert(h?.pid && h.port>=lo && h.port<=hi);
  const command=processCommand(h.pid);
  if(h.isSwift) assert(command.includes(executable) && command.includes('AGENTDECK_DATA_DIR='+swiftData),'Not the isolated app');
  else assert(command.includes(cli) && command.includes('AGENTDECK_DATA_DIR='+nodeData),'Not the isolated CLI');
  owned.add(h.pid);return h;
}
async function owner(swift,ms=40_000) {
  const h=await until(`${swift?'Swift':'Node'} owner`,async()=>{const h=await health();return h?.isSwift===swift?h:null;},ms);
  register(h);assert.deepEqual(h.posture,{loopbackOnly:true,noDeviceModules:true});
  noSharedSockets(h.pid);
  if(!observations.some(o=>o.pid===h.pid&&o.port===h.port)) {
    observations.push({at:new Date().toISOString(),pid:h.pid,port:h.port,isSwift:h.isSwift,build:h.build,posture:h.posture});
    writeFileSync(join(out,'owners.json'),JSON.stringify(observations,null,2));
  }
  if(swift) assert.deepEqual(Object.keys(h.modules??{}).filter(k=>k!=='gateway'),[]);
  assert(!h.gateway || h.gateway==='disconnected','Unexpected real Gateway connection');return h;
}
function sockets(pid,extra=[]) {
  try { return execFileSync('lsof',['-nP','-a','-p',String(pid),'-iTCP',...extra,'-Fn'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}); }
  catch(error) { if(error.status===1 && !String(error.stderr??'').trim())return '';throw new Error('Socket inspection unavailable'); }
}
function noSharedSockets(pid) {
  // Only endpoint ports: an IPv6 address may itself contain a :912x hextet.
  const snapshot=sockets(pid);
  if(/:(?:912\d|913\d)(?:->|$)/m.test(snapshot))writeFileSync(join(out,'shared-socket-refusal.txt'),snapshot);
  assert(!/:(?:912\d|913\d)(?:->|$)/m.test(snapshot),'Test process reached shared daemon window');
}
const socketsForListeners=pid=>sockets(pid,['-sTCP:LISTEN']);
async function appClient() {
  return until('app client of isolated Node',()=>{
    const pid=appPID();if(!pid)return null;
    const connected=sockets(pid,['-sTCP:ESTABLISHED']);
    if(!connected.includes('->127.0.0.1:'+port))return null;
    assert.equal(socketsForListeners(pid),'','Client app still owns a TCP listener');noSharedSockets(pid);owned.add(pid);return pid;
  },60_000);
}
async function startApp() {
  assert(!appPID(),'Test app already running');
  execFileSync('open',['-n','-j','-g','--env','AGENTDECK_DATA_DIR='+swiftData,'--env','AGENTDECK_PORT_WINDOW='+window,
    '--env','AGENTDECK_DAEMON_NO_GATEWAY=1','--stdout',join(out,`app-${step}.stdout.log`),'--stderr',join(out,`app-${step}.stderr.log`),app,
    '--args','-AgentDeckDisableDiscovery'],{timeout:10_000});
  const pid=await until('test app process',()=>appPID());owned.add(pid);return pid;
}
async function stopApp(signal='quit') {
  const pid=appPID();if(!pid)return;
  assert(owned.has(pid) && processCommand(pid).includes('AGENTDECK_DATA_DIR='+swiftData));
  if(signal==='quit'&&!args.includes('--signal-cleanup')) execFileSync('osascript',['-e',`tell application ${JSON.stringify(app)} to quit`],{timeout:20_000});
  else process.kill(pid,signal==='quit'?'SIGTERM':signal);
  await until('test app exit',()=>!appPID(),20_000);
}
function startNode() {
  const fd=openSync(join(out,`node-${step}.log`),'a');
  const child=spawn(process.execPath,[cli,'daemon','start','--foreground','--local','--loopback','--no-build','--port',String(port),'--port-window',window],
    {env:nodeEnv,cwd:root,stdio:['ignore',fd,fd]});owned.add(child.pid);return child;
}
async function cliCommand(verb) {
  const h=await health();if(h?.isSwift===false)register(h);
  execFileSync(process.execPath,[cli,'daemon',verb,'--port',String(port),...(verb==='restart'?['--local','--loopback','--no-build']:[])],
    {env:nodeEnv,cwd:root,timeout:150_000,stdio:['ignore',openSync(join(out,`cli-${step}-${verb}.log`),'a'),'pipe']});
}
let timelineClient;
async function snapshot(p=port) {
  const h=await health(p);assert(h?.pid,'No ready timeline owner');
  if(!timelineClient || timelineClient.pid!==h.pid || timelineClient.ws.readyState>WebSocket.OPEN) {
    timelineClient?.ws.terminate();
    const ws=new WebSocket(`ws://127.0.0.1:${p}`,{handshakeTimeout:3000,maxPayload:4*1024*1024});
    const client={pid:h.pid,ws,rows:[],ready:null};timelineClient=client;
    // Keep one normal client per owner. Reopening on every poll triggers the
    // production reconnect-flap guard (>6/30s), which intentionally omits history.
    client.ready=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{ws.terminate();reject(new Error('timeline snapshot timeout'));},5000);
      ws.on('error',error=>{clearTimeout(timer);reject(error);});
      ws.on('close',()=>{clearTimeout(timer);reject(new Error('timeline owner closed'));});
      ws.on('message',data=>{
        const e=JSON.parse(String(data));
        if(e.type==='timeline_history'&&!e.sessionId&&Array.isArray(e.entries)) {
          client.rows=e.entries;clearTimeout(timer);resolve();
        } else if(e.type==='timeline_event'&&e.entry) client.rows.push(e.entry);
      });
    });
  }
  await timelineClient.ready;return [...timelineClient.rows];
}
async function mark(label) {
  const prompt='lifecycle fixture '+runID+' '+label;
  const id='hermes-'+hash(runID+label).slice(0,32);
  await request(port,'/hooks/hermes_user_prompt_submit',{session_id:id,pid:process.pid,prompt});
  await until('synthetic timeline receipt',async()=>{const rows=await snapshot();return rows.some(e=>String(e.raw).includes(prompt));});
  await request(port,'/hooks/hermes_stop',{session_id:id,pid:process.pid,response:'synthetic completion '+prompt});
  await until('synthetic completion receipt',async()=>{const rows=await snapshot();return rows.some(e=>['chat_end','chat_response'].includes(e.type)&&String(e.raw).includes(prompt));});
  return prompt;
}
async function retains(prompt) {
  const rows=await snapshot();assert(rows.some(e=>String(e.raw).includes(prompt)),`Missing history: ${prompt}`);
  const starts=rows.filter(e=>e.type==='chat_start'&&String(e.raw).includes(prompt));assert.equal(starts.length,1,'Duplicate prompt after handover');
  // Node emits the supplied Hermes response; Swift emits its turn-end summary.
  // Preserve either existing shape through handover, rather than inventing one.
  const ends=rows.filter(e=>['chat_end','chat_response'].includes(e.type)&&String(e.raw).includes(prompt));assert.equal(ends.length,1,'Duplicate completion after handover');
}
function record(name,start,extra={}) {
  const row={name,passed:true,elapsedMs:Date.now()-start,...extra};reports.push(row);writeFileSync(join(out,'results.json'),JSON.stringify(reports,null,2));console.log('PASS '+name+' '+row.elapsedMs+'ms');
}
async function scenario(name,fn) {
  if(args.includes('--case')&&name!==arg('--case'))return;
  step++;console.log('RUN '+name);const started=Date.now();await fn(started);
}
async function stopNode() {const h=await health();if(h?.isSwift===false){register(h);await cliCommand('stop');await until('Node exit',()=>!alive(h.pid),20_000);}}
async function ensureVacant() {
  for(let p=lo;p<=hi;p++)await new Promise((ok,fail)=>{const s=createServer();s.once('error',fail);s.listen(p,'127.0.0.1',()=>s.close(ok));});
}
const portableHeaders={
  'AgentDeck-Surface-Protocol':'1','AgentDeck-Surface-Profile':'portable-reader/v1',
  'AgentDeck-Client-Id':'lifecycle-inflight','AgentDeck-Client-Version':'1.4.1-pocket',
  'AgentDeck-Product-Id':'io.pocketdaily.reader','AgentDeck-Board':'xteink_x4',
  'AgentDeck-Update-Channel':'stable','AgentDeck-Capabilities':'feed.pull,feed.conditional,outbox.push,glance.read,ota.feed',
};
async function raw(path,body,headers={}) {
  return fetch(`http://127.0.0.1:${port}${path}`,{method:body===undefined?'GET':'POST',
    headers:{'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(path==='/outbox'?{board:'xteink_x4',...body}:body)}),
    signal:AbortSignal.timeout(65_000)});
}
async function portable(path,body) {
  const r=await raw(path,body,portableHeaders);assert(r.ok,`${path}: ${r.status}`);return r.json();
}
async function feedbackCount() {
  const h=await health();
  if(!h.isSwift)return (await request(port,'/diag')).pocketAutonomy.feedbackCount;
  const body=await request(port,'/devices');
  return body.devices.find(d=>d.type==='card-feed').pocketAutonomy.feedbackCount;
}
let lastFeedbackReceipt;
async function selectPreference() {
  const feed=await portable('/feed');
  const card=feed.cards.find(c=>c.cardId.startsWith('module:quest:auto:preference:'))??feed.cards.find(c=>c.module?.choices?.length);
  if(!card&&lastFeedbackReceipt){await retryFeedback(lastFeedbackReceipt);return lastFeedbackReceipt;}
  assert(card,'Missing preference card in the fresh synthetic profile');
  const decision={cardId:card.cardId,action:'card_choice',choiceId:card.module.choices.find(c=>c.id==='work')?.id??card.module.choices[0].id,ageSec:0};
  const before=await feedbackCount();
  assert.equal((await portable('/outbox',{decisions:[decision]})).results[0].status,'applied');
  assert.equal(await feedbackCount(),before+1);lastFeedbackReceipt={decision,count:before+1};return lastFeedbackReceipt;
}
async function retryFeedback(receipt) {
  const response=await until('durable feedback receipt after reconnect',async()=>{
    const result=await raw('/outbox',{decisions:[{...receipt.decision,ageSec:5}]},portableHeaders);
    if(result.status===503)return null; // explicit unknown until the replica reconnects
    assert(result.ok,`Outbox retry: ${result.status}`);return result.json();
  },25_000);
  assert.equal(response.results[0].status,'applied');
  assert.equal(await feedbackCount(),receipt.count,'Duplicate feedback after owner replacement');
}
const inflightSockets=[];
async function approval(sid=randomUUID()) {
  const ws=new WebSocket(`ws://127.0.0.1:${port}`,{handshakeTimeout:3000});inflightSockets.push(ws);
  let rows=[];
  ws.on('message',data=>{const e=JSON.parse(String(data));if(e.type==='sessions_list')rows=e.sessions??[];});
  await new Promise((ok,fail)=>{ws.once('open',ok);ws.once('error',fail);});
  await request(port,'/hooks/codex_session_start',{session_id:sid,cwd:temporaryRoot,source:'cli',approvals_reviewer:'user'});
  await until('visible synthetic Codex session',()=>rows.find(r=>r.id.includes(sid)));
  let finished=false;
  const response=raw('/hooks/codex_permission_request',{session_id:sid,cwd:temporaryRoot,approvals_reviewer:'user',tool_name:'shell_command',tool_input:{command:'echo synthetic'}},
    {'X-AgentDeck-Hold':'55'}).then(r=>r.text()).catch(()=>null).then(body=>{finished=true;return body;});
  const row=await until('held approval request',()=>rows.find(r=>r.id.includes(sid)&&r.requestId));
  assert(!finished,'Approval was not held');
  return {sid,sessionId:row.id,id:row.requestId,response,ws,isFinished:()=>finished};
}
async function undecided(hold) {
  const body=await hold.response;
  assert(body===null||body==='','Retired owner fabricated an approval');hold.ws.terminate();
}
async function staleApproval(old) {
  const stale=await portable('/outbox',{decisions:[{cardId:'session:'+old.sessionId,sessionId:old.sessionId,
    requestId:old.id,action:'permission_decision',decision:'allow'}]});
  assert.equal(stale.results[0].status,'expired','Retired approval received a false applied receipt');
  const next=await approval(old.sid);assert.notEqual(next.id,old.id);
  next.ws.send(JSON.stringify({type:'permission_decision',requestId:old.id,decision:'allow'}));
  await delay(300);assert(!next.isFinished(),'Old request answered the replacement approval');
  next.ws.send(JSON.stringify({type:'permission_decision',requestId:next.id,decision:'deny'}));
  const body=JSON.parse(await next.response);
  assert.equal(body.hookSpecificOutput.decision.behavior,'deny');next.ws.terminate();
}
const firmware=Buffer.alloc(40*1024,0x41), firmwarePath=join(temporaryRoot,'synthetic-firmware.bin');
async function boardTransfer(hold=true,oldId) {
  writeFileSync(firmwarePath,firmware);
  const ws=new WebSocket(`ws://127.0.0.1:${port}`,{handshakeTimeout:3000});inflightSockets.push(ws);
  const frames=[];
  ws.on('message',data=>{
    const e=JSON.parse(String(data));frames.push(e);
    if(e.type==='esp32_ota_begin'||e.type==='esp32_ota_end'||(e.type==='esp32_ota_chunk'&&(!hold||e.seq===0))) {
      ws.send(JSON.stringify({type:'esp32_ota_ack',otaId:e.otaId,stage:e.type.replace('esp32_ota_',''),seq:e.seq,offset:e.offset??0,written:(e.offset??0)+1024}));
    }
  });
  await new Promise((ok,fail)=>{ws.once('open',ok);ws.once('error',fail);});
  ws.send(JSON.stringify({type:'device_info',board:'ttgo_t_display',ip:'127.0.0.99',version:'0.0.1',otaSupported:true,otaSlotSize:6291456,wifiConnected:true}));
  await delay(300);
  if(oldId)ws.send(JSON.stringify({type:'esp32_ota_ack',otaId:oldId,stage:'end'}));
  const h=await health();let done=false;
  const response=raw('/esp32/ota',{target:'ttgo_t_display',...(h.isSwift?{firmwareB64:firmware.toString('base64')}:{firmwarePath})})
    .then(async r=>({status:r.status,body:await r.json()})).catch(()=>({status:0,body:{ok:false}})).then(result=>{done=true;return result;});
  await until('synthetic OTA chunk',()=>frames.some(e=>e.type==='esp32_ota_chunk'&&e.seq===1));
  if(hold)assert(!done,'OTA did not wait for the chunk ACK');
  return {ws,frames,response,id:frames.find(e=>e.type==='esp32_ota_begin').otaId};
}
async function retiredTransfer(transfer) {
  const result=await transfer.response;assert.notEqual(result.body.ok,true,'Retired owner reported OTA success');
  assert(!transfer.frames.some(e=>e.type==='esp32_ota_end'),'Retired transfer advanced to end');transfer.ws.terminate();
}
async function otaScenario() {
  await scenario('Push OTA abort and fresh transfer across both owner directions',async start=>{
    await startApp();await owner(true);const first=await boardTransfer();
    startNode();await owner(false,150_000);await appClient();await retiredTransfer(first);
    const second=await boardTransfer(true,first.id);assert.notEqual(second.id,first.id);
    await stopNode();await retiredTransfer(second);await owner(true,200_000);
    const final=await boardTransfer(false,second.id);assert.notEqual(final.id,second.id);
    assert.equal((await final.response).body.ok,true);final.ws.terminate();
    record('Push OTA abort and fresh transfer across both owner directions',start);await stopApp();
  });
}

async function stagePull() {
  const h=await health();
  const body={target:'xteink_x4',stage:true,productId:'io.pocketdaily.reader',board:'xteink_x4',updateChannel:'stable',
    ...(h.isSwift?{firmwareB64:firmware.toString('base64')}:{firmwarePath})};
  const r=await raw('/esp32/ota',body);assert.equal(r.status,200);assert.equal((await r.json()).staged,true);
}
async function segment(from,limit) {
  const r=await raw(`/esp32/fw?board=xteink_x4&productId=io.pocketdaily.reader&updateChannel=stable&from=${from}&limit=${limit}`,undefined,portableHeaders);
  assert.equal(r.status,200);assert.equal(r.headers.get('x-fw-md5'),createHash('md5').update(firmware).digest('hex'));
  return Buffer.from(await r.arrayBuffer());
}
async function pullOtaScenario() {
  await scenario('Pull OTA resumes identical pre-staged bytes across both owners',async start=>{
    writeFileSync(firmwarePath,firmware);
    await startApp();await owner(true);await stagePull();
    const initial=await portable('/feed');assert.equal(initial.fw.md5,createHash('md5').update(firmware).digest('hex'));
    const prefix=await segment(0,32768);assert.equal(prefix.length,32768);
    startNode();await owner(false,150_000);await appClient();
    // Image/config distribution is a separate contract: explicitly stage the
    // identical synthetic image on the incoming owner before resuming bytes.
    await stagePull();const suffix=await segment(32768,firmware.length);
    assert.deepEqual(Buffer.concat([prefix,suffix]),firmware);
    assert((await portable('/feed')).fw,'Download was incorrectly treated as an installed-image acknowledgement');
    const first=await segment(0,32768);
    await stopNode();await owner(true,200_000);
    const rest=await segment(32768,firmware.length);assert.deepEqual(Buffer.concat([first,rest]),firmware);
    assert((await portable('/feed')).fw);
    const mismatch=await raw('/esp32/fw?board=xteink_x3&productId=io.pocketdaily.reader&updateChannel=stable',undefined,portableHeaders);
    assert(mismatch.status>=400,'Mismatched OTA identity was admitted');
    record('Pull OTA resumes identical pre-staged bytes across both owners',start,{imageBytes:firmware.length,stageDistribution:'explicit identical fixture on both owners'});
    await stopApp();
  });
}

async function sleepScenario(mode) {
  assert(['swift','node','both'].includes(mode));
  if(args.includes('--sleep-now')) {
    // Never let a private-port fixture suspend an occupied shared host.
    for(let p=9120;p<=9139;p++)await new Promise((ok,fail)=>{
      const socket=createServer();socket.once('error',()=>fail(new Error('Refusing actual sleep: shared daemon window occupied or unreadable')));
      socket.listen(p,'127.0.0.1',()=>socket.close(ok));
    });
  }
  await scenario(`Actual sleep/wake ${mode}`,async start=>{
    if(mode!=='swift'){startNode();await owner(false);}
    if(mode!=='node'){await startApp();if(mode==='both')await appClient();else await owner(true);}
    const before=await owner(mode==='swift');const receipt=await selectPreference();
    const hold=await approval(), transfer=await boardTransfer();
    const readyAt=Date.now();
    writeFileSync(join(out,'sleep-ready.json'),JSON.stringify({mode,readyAt,pid:before.pid,isSwift:before.isSwift}));
    console.log(`SLEEP_READY ${mode}`);
    if(args.includes('--sleep-now'))execFileSync('/usr/bin/pmset',['sleepnow'],{timeout:10_000});
    await until('controller verified actual macOS sleep/wake',()=>existsSync(join(out,'wake-verified.json')),15*60_000);
    assert(Date.now()-readyAt>=35_000,'Wake interval did not cross hold/OTA deadlines');
    if(hold.ws.readyState===WebSocket.OPEN)hold.ws.send(JSON.stringify({type:'permission_decision',requestId:hold.id,decision:'allow'}));
    if(transfer.ws.readyState===WebSocket.OPEN)transfer.ws.send(JSON.stringify({type:'esp32_ota_ack',otaId:transfer.id,stage:'chunk',seq:1}));
    await until('expired approval released',hold.isFinished,40_000);await undecided(hold);await retiredTransfer(transfer);
    const after=await owner(mode==='swift',90_000);assert.equal(after.pid,before.pid,'Sleep promoted a healthy incumbent');
    if(mode==='both')await appClient();await retryFeedback(receipt);
    await staleApproval(hold);
    record(`Actual sleep/wake ${mode}`,start,{oldPID:before.pid,newPID:after.pid,readyAt,restoredAt:Date.now()});
    if(mode!=='node')await stopApp();if(mode!=='swift')await stopNode();
  });
}

async function replicaScenario() {
  await scenario('Unconfirmed initial replica and response-loss retry stay explicit',async start=>{
    startNode();await owner(false);
    const ws=new WebSocket(`ws://127.0.0.1:${port}`,{handshakeTimeout:3000});inflightSockets.push(ws);
    let latest,acknowledge=false;
    const ack=()=>{if(latest)ws.send(JSON.stringify({type:'daemon_checkpoint_ack',checkpointId:latest.writer+':'+latest.sequence}));};
    ws.on('message',data=>{const e=JSON.parse(String(data));if(e.daemonCheckpoint){latest=JSON.parse(e.daemonCheckpoint);if(acknowledge)ack();}});
    await new Promise((ok,fail)=>{ws.once('open',ok);ws.once('error',fail);});
    await until('initial replica invitation',()=>latest);
    ws.send(JSON.stringify({type:'daemon_checkpoint_ack',checkpointId:'subscribe'}));await delay(100);
    assert.equal((await raw('/feed',undefined,portableHeaders)).status,503,'Unconfirmed replica was reported durable');
    acknowledge=true;ack();const feed=await portable('/feed');
    const card=feed.cards.find(c=>c.module?.choices?.length);assert(card);
    const decision={cardId:card.cardId,action:'card_choice',choiceId:card.module.choices[0].id};
    acknowledge=false;
    assert.equal((await raw('/outbox',{decisions:[decision]},portableHeaders)).status,503);
    const count=await feedbackCount();assert.equal(count,1);
    acknowledge=true;ack();await retryFeedback({decision,count});
    ws.terminate();await delay(100);
    record('Unconfirmed initial replica and response-loss retry stay explicit',start);await stopNode();
  });
}


async function configurationRoster() {
  return new Promise((resolve,reject) => {
    const ws=new WebSocket(`ws://127.0.0.1:${port}`,{handshakeTimeout:3000});
    const timer=setTimeout(()=>{ws.terminate();reject(new Error('Configuration roster timeout'));},4000);
    ws.on('error',error=>{clearTimeout(timer);reject(error);});
    ws.on('message',data=>{const e=JSON.parse(String(data));if(e.type==='sessions_list'){clearTimeout(timer);resolve(e.sessions??[]);ws.terminate();}});
  });
}
async function configurationScenarios() {
  const { rawSessionId }=await import('../shared/dist/index.js');
  const configurationSessionId = label => `hermes-${hash(runID+label).slice(0,32)}`;
  const pixoo = n => ({devices:[{ip:'127.0.0.2',name:`Synthetic ${n} / 작업`,brightness:n,animation:n%2?'tide':'loop'}],autoDiscover:false});
  const seed = (dir,label) => {
    const file=join(dir,'settings.json'),root=JSON.parse(readFileSync(file,'utf8'));
    root.ownerOnly=label;root.pixooDevices=[{ip:'127.0.0.2',future:`local-${label}`}];root.pixooAutoDiscover=false;
    writeFileSync(file,JSON.stringify(root));
  };
  seed(nodeData,'node');seed(swiftData,'swift');
  const verifyLocal = (dir,label) => {
    const root=JSON.parse(readFileSync(join(dir,'settings.json'),'utf8'));
    assert.equal(root.ownerOnly,label,'Unrelated settings overwritten');
    if(root.pixooDevices?.length)assert.equal(root.pixooDevices[0].future,`local-${label}`,'Local unknown device field overwritten');
  };
  const setPixoo = async value => until('durable Pixoo configuration',async()=>{
    const before=await request(port,'/configuration/pixoo');
    const r=await raw('/configuration/pixoo',{revision:before.revision,configuration:value});
    if(r.status===503)return null;
    assert.equal(r.status,200);const saved=await r.json();assert.deepEqual(saved.configuration,value);return saved;
  },25_000);
  const pin = async (id,weight) => until('durable pin configuration',async()=>{
    const r=await raw('/sessions/order',{sessionId:id,weight});if(r.status===503)return null;
    assert.equal(r.status,200);return r.json();
  },25_000);
  const verify = async (value,id,weight) => {
    assert.deepEqual((await request(port,'/configuration/pixoo')).configuration,value);
    const pins=(await request(port,'/sessions/order')).pins;
    assert.equal(pins.find(p=>p.id===id)?.weight,weight);
  };
  const emit = async id => request(port,'/hooks/hermes_user_prompt_submit',{session_id:id,pid:process.pid,prompt:`Synthetic configuration ${id}`});
  const verifyRoster = async (id,weight) => until('pin in real sessions_list',async()=>{
    const row=(await configurationRoster()).find(r=>rawSessionId(r.id)===id);
    return row && (weight===undefined ? row.weight===undefined : row.weight===weight);
  });
  const clearPins = async()=>{for(const p of (await request(port,'/sessions/order')).pins)await pin(p.id,0);};
  await scenario('Configuration Swift-only change and relaunch',async start=>{
    await startApp();await owner(true);await clearPins();
    const id=configurationSessionId('swift');await emit(id);await pin(id,-5);await verifyRoster(id,-5);
    await pin(id,7);await verifyRoster(id,7);await pin(id,0);await verifyRoster(id,undefined);await pin(id,-7);
    const saved=await setPixoo(pixoo(27));verifyLocal(swiftData,'swift');
    const beforeInactive=readFileSync(join(nodeData,'settings.json'),'utf8');
    execFileSync(process.execPath,[cli,'pixoo','--port',String(port),'add','127.0.0.3','--no-test','--name','Synthetic CLI','--brightness','19'],{env:nodeEnv,cwd:root,timeout:20000,stdio:'pipe'});
    assert((await request(port,'/configuration/pixoo')).configuration.devices.some(d=>d.ip==='127.0.0.3'),'CLI wrote the inactive profile instead of Swift');
    assert.equal(readFileSync(join(nodeData,'settings.json'),'utf8'),beforeInactive);
    execFileSync(process.execPath,[cli,'pixoo','--port',String(port),'remove','127.0.0.3'],{env:nodeEnv,cwd:root,timeout:20000,stdio:'pipe'});
    assert.equal((await raw('/sessions/order',{sessionId:id,weight:true})).status,400);
    await stopApp();await startApp();await owner(true);await verify(pixoo(27),id,-7);await emit(id);await verifyRoster(id,-7);
    assert.equal((await raw('/configuration/pixoo',{revision:saved.revision,configuration:pixoo(28)})).status,200);
    assert.equal((await raw('/configuration/pixoo',{revision:saved.revision,configuration:{devices:[],autoDiscover:false}})).status,409);
    record('Configuration Swift-only change and relaunch',start);await stopApp();
  });
  await scenario('Configuration Node-only change and restart',async start=>{
    startNode();await owner(false,150_000);await clearPins();const id=configurationSessionId('node');
    await pin(id,-9);await setPixoo(pixoo(35));verifyLocal(nodeData,'node');
    assert.equal((await raw('/configuration/pixoo',{revision:'invalid',configuration:{devices:[],autoDiscover:false}},{Origin:'https://untrusted.invalid'})).status,401);
    await stopNode();startNode();await owner(false,150_000);await verify(pixoo(35),id,-9);
    const legacy=new WebSocket(`ws://127.0.0.1:${port}`,{handshakeTimeout:3000});
    await new Promise((resolve,reject)=>{legacy.once('open',resolve);legacy.once('error',reject);});
    legacy.send(JSON.stringify({type:'daemon_checkpoint_ack',checkpointId:'subscribe'}));await delay(200);
    assert.equal((await raw('/sessions/order',{sessionId:id,weight:1})).status,503,'Old replicas must not falsely promise configuration durability');
    await verify(pixoo(35),id,-9);legacy.terminate();await delay(200);
    record('Configuration Node-only change and restart',start);await stopNode();
  });
  await scenario('Configuration Node-first client edits and promotion',async start=>{
    startNode();await owner(false,150_000);await clearPins();const id=configurationSessionId('node-first');
    await pin(id,-11);await setPixoo(pixoo(41));
    const inactive=JSON.parse(readFileSync(join(swiftData,'settings.json'),'utf8')).pixooDevices;
    await startApp();await appClient();await setPixoo(pixoo(43));
    await until('configuration replica staged',()=>{try{return JSON.parse(readFileSync(join(swiftData,'daemon-checkpoint-peer.json'),'utf8')).configuration.pixoo.devices[0].brightness===43;}catch{return false;}});
    assert.deepEqual(JSON.parse(readFileSync(join(swiftData,'settings.json'),'utf8')).pixooDevices,inactive,'A client must not mutate its inactive settings');
    await stopApp();await startApp();await appClient();await verify(pixoo(43),id,-11);
    await stopNode();await owner(true,200_000);await verify(pixoo(43),id,-11);verifyLocal(swiftData,'swift');
    await emit(id);await verifyRoster(id,-11);await pin(id,0);await verifyRoster(id,undefined);await setPixoo({devices:[],autoDiscover:false});
    await stopApp();await startApp();await owner(true);await verify({devices:[],autoDiscover:false},id,undefined);
    record('Configuration Node-first client edits and promotion',start);await stopApp();
  });
  await scenario('Configuration Swift-first repeated bidirectional handover',async start=>{
    seed(swiftData,'swift');seed(nodeData,'node');
    await startApp();await owner(true);await clearPins();const id=configurationSessionId('swift-first');
    await pin(id,-13);const old=await setPixoo(pixoo(51));
    const legacy=await raw('/stand-down',{}, {'X-AgentDeck-Checkpoint':'1'});assert.equal(legacy.status,412);await owner(true);
    startNode();await owner(false,150_000);await appClient();await verify(pixoo(51),id,-13);verifyLocal(nodeData,'node');
    await pin(id,17);await setPixoo(pixoo(52));
    assert.equal((await raw('/configuration/pixoo',{revision:old.revision,configuration:{devices:[],autoDiscover:false}})).status,409);
    await stopNode();await owner(true,200_000);await verify(pixoo(52),id,17);await setPixoo(pixoo(53));await pin(id,-19);
    startNode();await owner(false,150_000);await appClient();await verify(pixoo(53),id,-19);
    await stopApp();await stopNode();startNode();await owner(false,150_000);await verify(pixoo(53),id,-19);
    verifyLocal(nodeData,'node');verifyLocal(swiftData,'swift');
    const checkpoint=readFileSync(join(nodeData,'daemon-checkpoint.json'),'utf8');
    assert(!checkpoint.includes('ownerOnly')&&!checkpoint.includes('local-node')&&!checkpoint.includes('local-swift'),'Unknown settings escaped into checkpoint');
    record('Configuration Swift-first repeated bidirectional handover',start);await stopNode();
  });
}

async function coldRecoveryScenarios() {
  const shared=join(swiftData,'RecoveryFixture');mkdirSync(shared,{recursive:true});
  const id='hermes-'+hash(runID+'cold').slice(0,32);
  const config=n=>({devices:[{ip:'127.0.0.2',brightness:n,animation:'tide'}],autoDiscover:false});
  const edit=async (value,weight)=>{
    const before=await request(port,'/configuration/pixoo');
    const result=await raw('/configuration/pixoo',{revision:before.revision,configuration:value});assert.equal(result.status,200);
    assert.equal((await raw('/sessions/order',{sessionId:id,weight})).status,200);
  };
  const verify=async(value,weight)=>{
    assert.deepEqual((await request(port,'/configuration/pixoo')).configuration,value);
    assert.equal((await request(port,'/sessions/order')).pins.find(p=>p.id===id)?.weight,weight);
  };
  let receipt;
  await scenario('Cold Node to absent Swift restores settings and receipt',async start=>{
    startNode();await owner(false,150_000);
    await startApp();await appClient();
    await until('initial native checkpoint inbox',()=>existsSync(join(swiftData,'daemon-checkpoint-peer.json')));
    await until('recovery setup confirmed by current replica',async()=>{
      const response=await raw('/configuration/recovery',{enabled:true,path:shared});if(response.status===503)return false;
      assert.equal(response.status,200);return true;
    });
    assert.equal(JSON.parse(readFileSync(join(swiftData,'daemon-checkpoint-peer.json'),'utf8')).writer,
      JSON.parse(readFileSync(join(nodeData,'daemon-checkpoint.json'),'utf8')).writer,'Configuration setup acknowledged the old checkpoint writer');
    await stopApp();
    await edit(config(27),-7);receipt=await selectPreference();
    await stopNode();assert(!appPID());
    await startApp();await owner(true);await verify(config(27),-7);await retryFeedback(receipt);
    record('Cold Node to absent Swift restores settings and receipt',start);await stopApp();
  });
  await scenario('Cold Swift to absent Node and back retains removals',async start=>{
    await startApp();await owner(true);
    assert.equal((await raw('/configuration/recovery',{enabled:true,path:shared})).status,200);
    await edit(config(31),-9);await stopApp();
    startNode();await owner(false,150_000);await verify(config(31),-9);await retryFeedback(receipt);
    await edit({devices:[],autoDiscover:false},0);await stopNode();
    await startApp();await owner(true);await verify({devices:[],autoDiscover:false},undefined);await retryFeedback(receipt);
    record('Cold Swift to absent Node and back retains removals',start);await stopApp();
  });
  await scenario('Cold recovery disconnect retains backup and native grant is required',async start=>{
    await startApp();await owner(true);
    assert.equal((await raw('/configuration/recovery',{enabled:true,path:'/private/tmp/ungranted-recovery'})).status,403);
    const backup=readFileSync(join(shared,'agentdeck-recovery.sqlite'));
    assert.equal((await raw('/configuration/recovery',{enabled:false})).status,200);
    assert(readFileSync(join(shared,'agentdeck-recovery.sqlite')).equals(backup));
    await stopApp();startNode();await owner(false,150_000);
    await edit(config(41),11);await stopNode();
    assert(readFileSync(join(shared,'agentdeck-recovery.sqlite')).equals(backup),'Disconnected runtime wrote recovery data');
    record('Cold recovery disconnect retains backup and native grant is required',start);
  });
}

async function inflightScenarios() {
  await scenario('Prepared handover lease expires without stopping Swift',async start=>{
    await startApp();const first=await owner(true);
    const prepared=await raw('/stand-down',{}, {'X-AgentDeck-Checkpoint':'1','X-AgentDeck-Configuration':'1'});assert.equal(prepared.status,200);
    const lease=await prepared.json();assert(lease.lease&&lease.continuity);
    assert.equal((await raw('/outbox',{decisions:[]},portableHeaders)).status,503);
    assert.equal((await raw('/stand-down/commit',{lease:'wrong',checkpointId:'wrong'})).status,409);
    await delay(10_300);
    assert.equal((await owner(true)).pid,first.pid);
    await portable('/feed');
    assert.equal((await raw('/stand-down/commit',{lease:lease.lease,checkpointId:JSON.parse(lease.continuity).writer+':'+JSON.parse(lease.continuity).sequence})).status,409);
    record('Prepared handover lease expires without stopping Swift',start);await stopApp();
  });
  await scenario('Feed response-loss retry survives Swift to Node and Node to Swift',async start=>{
    await startApp();await owner(true);const receipt=await selectPreference();const firstHold=await approval();
    startNode();await owner(false,150_000);await appClient();await undecided(firstHold);await staleApproval(firstHold);await retryFeedback(receipt);
    await until('native durable checkpoint replica',()=>{
      try { return JSON.parse(readFileSync(join(swiftData,'daemon-checkpoint-peer.json'),'utf8')).pocket.feedbackCount===receipt.count; }
      catch{return false;}
    });
    const secondHold=await approval();
    await stopNode();await undecided(secondHold);await owner(true,200_000);await staleApproval(secondHold);await retryFeedback(receipt);
    await stopApp();await startApp();await owner(true);await retryFeedback(receipt);
    record('Feed response-loss retry survives Swift to Node and Node to Swift',start);await stopApp();
  });
  await scenario('Silent occupied Node stays unknown; resume and crash retain Feed receipt',async start=>{
    startNode();const node=await owner(false);await startApp();await appClient();
    const receipt=await selectPreference();
    register(node);process.kill(node.pid,'SIGSTOP');
    try {
      await delay(12_000);
      assert.equal(socketsForListeners(appPID()),'','Swift took ownership while the Node listener was occupied');
      assert(socketsForListeners(node.pid).includes(':'+port),'Paused owner lost its listener');
    } finally {process.kill(node.pid,'SIGCONT');}
    await owner(false);await appClient();await retryFeedback(receipt);
    const crashingHold=await approval();register(node);process.kill(node.pid,'SIGKILL');
    await undecided(crashingHold);await owner(true,200_000);await retryFeedback(receipt);await staleApproval(crashingHold);
    record('Silent occupied Node stays unknown; resume and crash retain Feed receipt',start);await stopApp();
  });
}

try {
  await ensureVacant();assert(!appPID());
  if(args.includes('--fresh')) {
    // Explicit fixture reset, after proving every private listener vacant.
    for(const dir of [nodeData,swiftData])for(const name of readdirSync(dir)) {
      if(args.includes('--cold-recovery') && dir===swiftData && name==='RecoveryFixture') {
        for(const child of readdirSync(join(dir,name)))rmSync(join(dir,name,child),{recursive:true,force:true});
      }
      if(name!=='settings.json' && !(args.includes('--cold-recovery') && dir===swiftData && name==='RecoveryFixture'))rmSync(join(dir,name),{recursive:true,force:true});
    }
  }
  if(args.includes("--sleep-mode")) { await sleepScenario(arg("--sleep-mode")); } else if(args.includes('--cold-recovery')) { await coldRecoveryScenarios(); } else if(args.includes("--configuration")) { await configurationScenarios(); } else if(args.includes("--inflight")) { await replicaScenario(); await inflightScenarios(); await otaScenario(); await pullOtaScenario(); } else {
  await scenario('Swift-only quit and relaunch',async start=>{
    await startApp();const first=await owner(true);noSharedSockets(first.pid);const prompt=await mark('swift-only');const token=hash(first.pairingToken);
    await stopApp();await startApp();const next=await owner(true);assert.equal(hash(next.pairingToken),token);await retains(prompt);
    record('Swift-only quit and relaunch',start,{oldPID:first.pid,newPID:next.pid});await stopApp();
  });
  await scenario('Node-only stop/start and restart',async start=>{
    startNode();const first=await owner(false);const prompt=await mark('node-only');const token=hash(first.pairingToken);
    await stopNode();startNode();await owner(false);await retains(prompt);await cliCommand('restart');const next=await owner(false);assert.notEqual(next.pid,first.pid);assert.equal(hash(next.pairingToken),token);await retains(prompt);
    record('Node-only stop/start and restart',start);await stopNode();
  });
  await scenario('Node first; app quit/relaunch; Node restart; Node crash recovery',async start=>{
    startNode();let node=await owner(false);const token=hash(node.pairingToken);await startApp();await appClient();const prompt=await mark('node-first');await delay(2500);
    await stopApp();assert.equal((await owner(false)).pid,node.pid);await startApp();await appClient();
    await cliCommand('restart');node=await owner(false);await appClient();await retains(prompt);await delay(2500);
    register(node);process.kill(node.pid,'SIGKILL');const swift=await owner(true,90_000);assert.equal(hash(swift.pairingToken),token);await retains(prompt);
    record('Node first; app quit/relaunch; Node restart; Node crash recovery',start);await stopApp();
  });
  await scenario('Swift first; Node takeover; Node stop returns ownership',async start=>{
    await startApp();const first=await owner(true);const token=hash(first.pairingToken);const prompt=await mark('swift-first');
    startNode();const node=await owner(false,150_000);assert.equal(hash(node.pairingToken),token);assert.equal(appPID(),first.pid);await appClient();await retains(prompt);await delay(2500);
    await stopNode();const next=await owner(true,200_000);assert.equal(hash(next.pairingToken),token);await retains(prompt);
    record('Swift first; Node takeover; Node stop returns ownership',start);await stopApp();
  });
  await scenario('Simultaneous startup and crashed client app',async start=>{
    const launching=startApp();startNode();await launching;const node=await owner(false,150_000);await appClient();await stopApp('SIGKILL');assert.equal((await owner(false)).pid,node.pid);
    await startApp();await appClient();record('Simultaneous startup and crashed client app',start);await stopApp();await stopNode();
  });
  await scenario('Incoming Node dies after Swift stand-down',async start=>{
    await startApp();const first=await owner(true);const prompt=await mark('failed-incoming');const child=startNode();
    // Health silence is unknown, not proof of stand-down. Observe the actual
    // listener gap on both owned processes before killing the incoming owner.
    await until('Swift listener yielded before Node binds',()=>
      socketsForListeners(first.pid)==='' && socketsForListeners(child.pid)==='',90_000);
    assert(alive(child.pid));
    const incomingCommand=processCommand(child.pid);
    assert(incomingCommand.includes(cli)&&incomingCommand.includes('AGENTDECK_DATA_DIR='+nodeData));
    process.kill(child.pid,'SIGKILL');
    const recovered=await owner(true,230_000);assert.equal(recovered.pid,first.pid);await retains(prompt);
    record('Incoming Node dies after Swift stand-down',start);await stopApp();
  });
  }
  assert(reports.length>0,'No matching lifecycle scenario');
  console.log(args.includes('--case')?'LIFECYCLE_PARTIAL_ACCEPTED':'LIFECYCLE_ACCEPTED');
} catch(error) {
  writeFileSync(join(out,'failure.json'),JSON.stringify({step,error:String(error),stack:error.stack},null,2));throw error;
} finally {
  timelineClient?.ws.terminate();
  for(const ws of inflightSockets)ws.terminate();
  const cleanupErrors=[];
  await stopApp().catch(e=>cleanupErrors.push(e));
  await stopNode().catch(e=>cleanupErrors.push(e));
  for(const pid of owned) {
    if(!alive(pid))continue;
    const c=processCommand(pid);
    if((c.includes(cli)&&c.includes('AGENTDECK_DATA_DIR='+nodeData)) || (c.includes(executable)&&c.includes('AGENTDECK_DATA_DIR='+swiftData))) {
      try{process.kill(pid,'SIGTERM');await until('owned process cleanup',()=>!alive(pid),20_000);}catch(e){cleanupErrors.push(e);}
    }
  }
  await ensureVacant().catch(e=>cleanupErrors.push(e));
  if(cleanupErrors.length) throw new AggregateError(cleanupErrors,'Private lifecycle cleanup failed');
}
