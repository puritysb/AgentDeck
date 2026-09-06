/** Run synthetic context boundaries through the actual judge HTTP adapter. Private evidence only. */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
const root=resolve(process.argv[2]??'');
const backend=process.argv[3];
if(!['mlx','ollama'].includes(backend)||!existsSync(join(root,'boundaries.json')))throw new Error('Invalid fixture');
process.umask(0o077);
process.env.AGENTDECK_DATA_DIR=join(root,'settings');
const {callJudgeWithMeta,parseJudgeJson}=await import('../bridge/dist/apme/runner.js');
const cfg={backend:backend==='mlx'?'mlx':'openai',
  model:backend==='mlx'?'mlx-community/gemma-4-26b-a4b-it-4bit':'foundby-gemma4-ad:16k',
  endpoint:backend==='mlx'?'http://127.0.0.1:8800/v1/chat/completions':'http://127.0.0.1:11434/v1',
  fallbackToMlx:false,fallbackToFoundationModels:false};
if(backend==='ollama')cfg.reasoningEffort='none';
const original=globalThis.fetch;
let calls=[];
globalThis.fetch=async(input,init)=>{
  if(!/^http:\/\/127\.0\.0\.1:(8800|11434)\//.test(String(input)))throw new Error('Non-local request blocked');
  const c={url:String(input),request:init?.body?JSON.parse(init.body):null};calls.push(c);
  const start=performance.now();
  try{const r=await original(input,init);c.status=r.status;c.response=await r.clone().text();c.elapsed_s=(performance.now()-start)/1000;return r;}
  catch(e){c.error=String(e);throw e;}
};
for(const fixture of JSON.parse(readFileSync(join(root,'boundaries.json'),'utf8'))){
  const path=join(root,`boundary-${backend}-${fixture.case}.json`);
  if(existsSync(path))continue;
  calls=[];const start=performance.now();let result,error;
  try{result=await callJudgeWithMeta(fixture.prompt,cfg);}catch(e){error=String(e);}
  const record={backend,...fixture,result,error,calls,elapsed_s:(performance.now()-start)/1000,
    parseable:result?!!parseJudgeJson(result.text):false};
  writeFileSync(path,JSON.stringify(record,null,2));
  console.log(JSON.stringify({backend,case:fixture.case,s:record.elapsed_s,parseable:record.parseable,error,calls:calls.length}));
}
