#!/usr/bin/env node
/** Opt-in developer acceptance: actual signed app + real isolated CLI processes.
 * Never run against production 9120, an installed app, real sources or hardware.
 * Build/sign the alternate-bundle app and bootstrap its typed preferences first.
 */
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, openSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('..', import.meta.url));
const { WebSocket } = createRequire(new URL('../bridge/package.json', import.meta.url))('ws');
const args = process.argv.slice(2);
if (!args.includes('--allow-visible-fixtures')) throw new Error('Requires --allow-visible-fixtures and a prepared alternate signed app.');
const arg = name => { const i=args.indexOf(name); assert(i>=0 && args[i+1], `Missing ${name}`); return args[i+1]; };
const app=resolve(arg('--app')), swiftData=resolve(arg('--swift-data')), out=resolve(arg('--out'));
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
const nodeData=join(temporaryRoot,'node-data'), home=join(temporaryRoot,'node-home'), bin=join(temporaryRoot,'bin');
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
  assert(!/:(?:912\d|913\d)(?:\b|->)/.test(sockets(pid)),'Test process reached shared daemon window');
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
  if(signal==='quit') execFileSync('osascript',['-e',`tell application ${JSON.stringify(app)} to quit`],{timeout:20_000});
  else process.kill(pid,signal);
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
async function scenario(name,fn) {step++;console.log('RUN '+name);const started=Date.now();await fn(started);}
async function stopNode() {const h=await health();if(h?.isSwift===false){register(h);await cliCommand('stop');await until('Node exit',()=>!alive(h.pid),20_000);}}
async function ensureVacant() {
  for(let p=lo;p<=hi;p++)await new Promise((ok,fail)=>{const s=createServer();s.once('error',fail);s.listen(p,'127.0.0.1',()=>s.close(ok));});
}
try {
  await ensureVacant();assert(!appPID());
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
  console.log('LIFECYCLE_ACCEPTED');
} catch(error) {
  writeFileSync(join(out,'failure.json'),JSON.stringify({step,error:String(error),stack:error.stack},null,2));throw error;
} finally {
  timelineClient?.ws.terminate();
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
