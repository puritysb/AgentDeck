import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { RELAY_POLICY } from '../daemon-relay-policy.js';
import { emitPolicy, OUTPUT } from '../../../scripts/generate-daemon-relay.mjs';
import { sanitizeRelayedRows, selectRelayableRows, routeRelayCommand, RELAY_SESSION_COMMANDS } from '../../../bridge/src/daemon-relay.js';

const commands = [...RELAY_SESSION_COMMANDS].flatMap(type=>[{type},{type:'session_command',sessionId:'relay',command:{type}}]);
commands.push(...[{type:'permission_decision',requestId:'rid',decision:'allow'},{type:'select_option',sessionId:'relay',index:0},{type:'voice'},{type:'session_command',sessionId:'local',command:{type:'interrupt'}},{type:'session_command',sessionId:'missing',command:{type:'interrupt'}}] as typeof commands);
const vectors: unknown[] = [null, {}, [], [null, 3, {}, {id:'a'}, {id:'a'}, {id:'managed',controlMode:'managed'}, {id:'openclaw-gateway'}],
 [{id:'observed:claude:a',port:9123,alive:false,state:4,projectName:['bad'],weight:1e20,stopRequested:false,waitingOn:null,elapsedSec:9,secret:'drop',options:[{label:'yes',index:0,selected:false,nested:{secret:true}},'bad'],foldedSessionIds:['a',9,'b']}],
 [{id:'b',state:'processing',agentType:'unknown-agent',weight:-3.7,groupSize:2,subagents:{active:0},coordination:{},waitingOn:{phase:'running'},question:'안녕하세요'}],
 [{id:'observed:opencode:read-only',agentType:'opencode',controllerInput:false,liveAnswerable:false}],
 Array.from({length:70},(_,i)=>({id:String(i),projectName:'worker',liveAnswerable:false}))];
describe('mixed daemon relay policy',()=>{
 it('preserves an explicit read-only controller boundary across relay normalization',()=>{
  expect(sanitizeRelayedRows([{id:'observed:opencode:read-only',agentType:'opencode',controllerInput:false,liveAnswerable:false}]))
   .toMatchObject([{controllerInput:false,liveAnswerable:false}]);
 });
 it('generates the canonical native policy without drift',()=>expect(readFileSync(OUTPUT,'utf8')).toBe(emitPolicy(RELAY_POLICY)));
 it.skipIf(process.platform!=='darwin')('matches Node typed rows, null/false, bounds, exclusion and volatile-field rules in real Swift',()=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-parity-'));
  try {
   const main=join(dir,'main.swift');
   writeFileSync(main,`import Foundation
@globalActor actor DaemonActor { static let shared = DaemonActor() }
Task { @DaemonActor in
let input = try JSONSerialization.jsonObject(with:FileHandle.standardInput.readDataToEndOfFile()) as! [String:Any]
let vectors = input["vectors"] as! [Any]
let output = vectors.map { value -> [String:Any] in
 let rows = DaemonRelayRules.sanitize(value)
 return ["rows":rows,"published":DaemonRelayRules.publish(rows,excluding:["b"])]
}
let hub = DaemonRelayHub(instanceId:"hub"), socket = UUID()
var sent: [[String:Any]] = []
hub.handle(["type":"relay_hello","v":1,"instanceId":"worker"],socket:socket,send:{ sent.append($0) })
hub.handle(["type":"relay_sessions","sessions":[["id":"relay","requestId":"rid"]]],socket:socket,send:{_ in})
let routed = (input["commands"] as! [[String:Any]]).map { cmd -> [String:Any] in
 sent.removeAll()
 let accepted = hub.route(cmd,focused:"relay",local:[["id":"local"]])
 return ["routed":accepted,"command":sent.last?["command"] ?? NSNull()]
}
FileHandle.standardOutput.write(DaemonRelayRules.data(["vectors":output,"commands":routed])!)
exit(0)
}
dispatchMain()
`);
   execFileSync('xcrun',['swiftc','-swift-version','6','-module-cache-path',join(dir,'modules'),OUTPUT,'apple/AgentDeck/Model/SessionWeightRules.generated.swift','apple/AgentDeck/Daemon/Relay/DaemonRelay.swift',main,'-o',join(dir,'probe')],{timeout:90_000,stdio:'pipe'});
   const actual=JSON.parse(execFileSync(join(dir,'probe'),[],{input:JSON.stringify({vectors,commands}),encoding:'utf8',timeout:10_000}));
   expect(actual.vectors).toEqual(vectors.map(v=>{const rows=sanitizeRelayedRows(v);return {rows,published:selectRelayableRows(rows,new Set(['b']))};}));
   expect(actual.commands).toEqual(commands.map(cmd=>{const decision=routeRelayCommand(cmd as never,{owns:id=>id==='relay',ownerOfRequest:rid=>rid==='rid'?'relay':undefined,focusedSessionId:'relay',resolveId:String});return {routed:decision!==null,command:decision?.command??null};}));
  } finally {rmSync(dir,{recursive:true,force:true});}
 },120_000);
});
