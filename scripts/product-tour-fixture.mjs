#!/usr/bin/env node
// Developer-only recording feed. No discovery, credentials, live agents or controls.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from '../bridge/node_modules/ws/wrapper.mjs';

export const sceneNames = ['overview', 'focus', 'collaboration', 'usage', 'history', 'devices', 'idle'];
export function makeTourScene(scene, now = Date.now(), port = 19570) {
  if (!sceneNames.includes(scene)) throw new Error('Unknown tour scene');
  const defs = [
    ['claude','claude-code','Dashboard','Claude Sonnet','Edit','Polish the dashboard'],
    ['codex','codex-cli','API Client','GPT Codex','Test','Verify the API client'],
    ['opencode','opencode','Documentation','Local model','Write','Prepare the release guide'],
    ['openclaw','openclaw','OpenClaw','Local assistant','Read','Triage incoming work'],
    ['hermes','hermes','Research','Local model','Read','Summarize the findings'],
    ['kiro','kiro-cli','Accessibility','Configured model','Read','Review contrast and labels'],
    ['antigravity','antigravity','Protocol','Configured model','Test','Check message compatibility'],
  ];
  const sessions = defs.map(([key,agentType,projectName,modelName,currentTool,goal],i)=>({
    id:`tour-${key}`,port,projectName,agentType,modelName,currentTool,goal,activity:goal,
    currentTask:goal,alive:true,state:scene==='idle'?'idle':i===1?'idle':i===5?'idle':'processing',
    controlMode:'observed',controllerInput:false,controllerAnswerable:false,liveAnswerable:false,
    startedAt:new Date(now-((i+2)*60000)).toISOString(),contextPercent:[24,38,16,12,21,7,19][i],
    totalTokens:18000+i*3200,
    waitingOn:i===1?{kind:'ci',provider:'github-actions',phase:'running',agentWaiting:true,evidence:'github',openedAt:now-180000,checks:{total:8,passed:6,failed:0,pending:2}}:null,
    ...(i===0?{subagents:{active:1,peak:2,completed:1},coordination:{backgroundJobs:1,spawnedActive:1,spawnedCompleted:1,messagesIn:1,messagesOut:2,lastPeerName:'API Client',lastRelationAt:now-60000}}:{}),
  }));
  const entries=[
    {type:'chat_start',raw:'Polish the dashboard and check its accessibility',sessionId:'tour-claude',agentType:'claude-code',projectName:'Dashboard'},
    {type:'tool_exec',raw:'Read · DashboardLayout.swift',sessionId:'tour-claude',agentType:'claude-code',projectName:'Dashboard'},
    {type:'chat_start',raw:'Verify the API contract before the release',sessionId:'tour-codex',agentType:'codex-cli',projectName:'API Client'},
    {type:'tool_exec',raw:'Test · API contract checks',sessionId:'tour-codex',agentType:'codex-cli',projectName:'API Client'},
    {type:'chat_response',raw:'API checks passed. Waiting for the CI result.',sessionId:'tour-codex',agentType:'codex-cli',projectName:'API Client'},
    {type:'chat_response',raw:'Contrast and labels reviewed. Findings recorded.',sessionId:'tour-kiro',agentType:'kiro-cli',projectName:'Accessibility'},
  ].map((e,i)=>({...e,ts:now-(entriesLength-i)*25000}));
  const selected=scene==='focus'?'tour-codex':scene==='collaboration'?'tour-claude':'';
  return [
    {type:'state_update',...sessions[0],sessionId:sessions[0].id,focusedSessionId:selected,daemonPort:port,
      permissionMode:'default',gatewayAvailable:true,gatewayConnected:true,gatewayHasError:false,
      moduleHealth:{streamDeck:{available:true,devices:[{id:'tour-deck',name:'Stream Deck +',family:'streamdeckplus',columns:4,rows:2}]},d200h:{connected:true},timebox:{configuredDeviceCount:0,connected:false},idotmatrix:{configuredDeviceCount:0,connected:false}}},
    {type:'sessions_list',sessions},
    {type:'usage_update',usageStale:false,codexPlanType:'plus',codexRateLimits:{planType:'plus',primary:{usedPercent:36,windowMinutes:300,resetsAt:new Date(now+7200000).toISOString(),stale:false},secondary:{usedPercent:58,windowMinutes:10080,resetsAt:new Date(now+3*86400000).toISOString(),stale:false}}},
    {type:'timeline_history',entries},
  ];
}
const entriesLength=6;
export function tourTasks(session='tour-claude',now=Date.now()) {
  const titles=['Polish dashboard accessibility','Check responsive cards'];
  return titles.map((summary,i)=>({id:`${session}-task-${i}`,sessionId:session,title:summary,summary,firstPrompt:summary,
    taskIndex:i,startedAt:now-(i+1)*3600000,endedAt:now-(i+1)*1800000,turnCount:1,answeredTurns:1,
    toolCount:2,overallScore:.88-i*.04,outcome:'success',agentType:'claude-code',projectName:'Dashboard',taskCategory:'coding',costUsd:.04,costKnown:true,modelId:'sample-model',compositeScore:.88-i*.04,boundarySignal:'idle_timeout'}));
}
export function tourDetail(id,now=Date.now()) {
  const session=id.replace(/-task-\d+$/,''); const task=tourTasks(session,now).find(t=>t.id===id);
  if(!task)return null;
  const events=[
    {kind:'user_message',ts:now-600000,text:task.summary+' and verify keyboard navigation.'},
    {kind:'tool',ts:now-500000,name:'Read',status:'success',input:{file:'DashboardLayout.swift'},output:'Read the layout components.'},
    {kind:'subagent',id:'layout-check',name:'Layout check',phase:'completed',summary:'Verified compact and wide cards',ts:now-450000},
    {kind:'subagent',id:'contrast-check',name:'Contrast check',phase:'started',summary:'Reviewing labels and focus states',ts:now-400000},
    {kind:'relation',relationId:'tour-handoff',relation:'messaged',direction:'out',peerSessionId:'tour-codex',peerName:'API Client',phase:'closed',evidence:'send_message',detail:'Please verify the API contract and reply with the result.',ts:now-300000},
    {kind:'tool',ts:now-200000,name:'Test',status:'success',input:{command:'node --test'},output:'12 checks passed.'},
    {kind:'assistant_message',responseKind:'final',ts:now-100000,text:'Updated the cards and focus order. All 12 sample checks passed.'},
  ].map((e,i)=>({...e,ts:task.startedAt+(i+1)*120000,turnIndex:0}));
  const evals=[{layer:'task_judge',metric:'overall',score:.88,judgeModel:'sample-local-judge',rubricVer:'sample-v1',createdAt:now-50000,raw:JSON.stringify({reasoning:'Sample judgement: the response reports the requested layout changes and successful checks. Inspect the trajectory and provide your own assessment.',done:['Responsive cards and keyboard navigation updated','12 sample checks reported passing'],missed:['Physical-device accessibility review is not recorded']})}];
  return {overallScore:.88,task,run:{id:'tour-run',sessionId:session,agentType:'claude-code',projectName:'Dashboard',model:'sample-model'},turns:[{turn_index:0,prompt:events[0].text,response:events.at(-1).text}],evals,
    sample:{schemaVersion:'agentdeck-eval/v1',id,sessionId:session,runId:'tour-run',agentType:'claude-code',index:0,boundarySignal:'manual',startedAt:task.startedAt,endedAt:task.endedAt,model:{modelId:'sample-model'},projectName:'Dashboard',events,cost:{inputTokens:12000,outputTokens:1800,costUsd:.04,costKnown:true,latencyMs:12000},summary:task.summary,outcome:'success',compositeScore:.88,taskCategory:'coding',scores:[]}};
}
export function communications(now=Date.now()) {
 return {schema:'agentdeck-communications/v1',capturedAt:now,since:now-86400000,truncated:false,events:[
  {id:'tour-message-1',sessionId:'tour-claude',peerSessionId:'tour-codex',peerName:'API Client',ts:now-60000,relation:'messaged',direction:'out',messageIntent:'request',messageFingerprint:'tour-check',detail:'Please verify the API contract and reply with the result.'},
  {id:'tour-message-2',sessionId:'tour-opencode',peerSessionId:'tour-claude',peerName:'Dashboard',ts:now-30000,relation:'messaged',direction:'out',messageIntent:'notification',detail:'Release guide draft is ready.'},
 ]};
}
export async function serveTour(port=19570) {
 if(!Number.isInteger(port)||port<1024||port>65535||port===9120)throw new Error('Choose an isolated non-production port');
 let scene='overview';const sockets=new Set();const events=()=>makeTourScene(scene,Date.now(),port);
 const send=(ws,event)=>{if(ws.readyState===ws.OPEN)ws.send(JSON.stringify(event));};
 const publish=()=>{for(const ws of sockets)for(const e of events())send(ws,e);};
 const json=(res,data,status=200)=>{const b=JSON.stringify(data);res.writeHead(status,{'content-type':'application/json','content-length':Buffer.byteLength(b)});res.end(b);};
 const apmeHtml=readFileSync(new URL('../apple/AgentDeck/Resources/apme-dashboard.html',import.meta.url),'utf8');
 const server=createServer((req,res)=>{
  const u=new URL(req.url,'http://127.0.0.1');
  if(u.pathname==='/capture/scene'&&req.method==='POST') {const next=u.searchParams.get('name');if(!sceneNames.includes(next))return json(res,{error:'unknown scene'},400);scene=next;publish();return json(res,{scene,at:Date.now()});}
  if(u.pathname==='/capture/status')return json(res,{scene,clients:sockets.size});
  if(u.pathname==='/dashboard/providers')return json(res,{providers:['codex','openclaw']});
  if(u.pathname==='/apme/communications')return json(res,communications());
  if(u.pathname==='/apme/tasks'){const tasks=tourTasks(u.searchParams.get('session')||'tour-claude');return json(res,{tasks,total:tasks.length,counts:{all:2,judged:2,reported:0,inprogress:0,attention:0,orphaned:0},facets:{agents:['claude-code'],projects:['Dashboard'],categories:['coding']}});}
  if(u.pathname.startsWith('/apme/tasks/')){const d=tourDetail(decodeURIComponent(u.pathname.split('/').at(-1)));return json(res,d||{error:'not found'},d?200:404);}
  if(u.pathname==='/apme'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'});return res.end(apmeHtml);}
  if(u.pathname==='/health')return json(res,{mode:'daemon',port,captureFixture:true});
  if(u.pathname.startsWith('/apme/'))return json(res,{runs:[],rows:[],scorecards:[],categories:[],samples:[]});
  json(res,{error:'not found'},404);
 });
 const wss=new WebSocketServer({server});wss.on('connection',ws=>{sockets.add(ws);send(ws,{type:'connection',status:'connected'});for(const e of events())send(ws,e);ws.on('close',()=>sockets.delete(ws));ws.on('message',b=>{let m;try{m=JSON.parse(String(b));}catch{return;}if(m.type==='ping')send(ws,{type:'pong'});if(m.type==='focus_session'){for(const peer of sockets)send(peer,{type:'state_update',focusedSessionId:m.sessionId});}if(m.type==='clear_session_focus'){for(const peer of sockets)send(peer,{type:'state_update',focusedSessionId:''});}});});
 await new Promise((ok,fail)=>{server.once('error',fail);server.listen(port,'127.0.0.1',ok);});
 const heartbeat=setInterval(()=>{for(const ws of sockets)send(ws,{type:'pong'});},5000);
 const stop=()=>{clearInterval(heartbeat);for(const ws of sockets)ws.terminate();wss.close();server.close(()=>process.exit(0));};process.once('SIGTERM',stop);process.once('SIGINT',stop);
 return {server,wss,port};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const {port}=await serveTour(Number(process.argv[2]||19570));console.log(`Native product-tour fixture: loopback ${port}; fictional sample data; no control execution.`);}
