// Offline evaluation only: never dispatches a command to an agent.
// node bridge/tools/evaluate-device-voice.mjs manifest.json settings.json report.json [gate-variant]
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { transcribeDeviceAudio } from '../dist/device-transcription.js';
import { stopFoundationModelsHelper } from '../dist/foundation-models-helper.js';
import { personalVoiceCommand } from '../dist/personal-voice-turn.js';
const [manifestPath, settingsPath, reportPath, gateVariant] = process.argv.slice(2);
if (!manifestPath || !settingsPath || !reportPath) throw new Error('Expected manifest.json settings.json report.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const config = JSON.parse(await readFile(settingsPath, 'utf8'));
const normalize = (s) => s.normalize('NFC').replace(/[\p{P}\p{Z}\s]/gu, '').toLowerCase();
function edits(a,b) {
  let previous=Array.from({length:b.length+1},(_,i)=>i);
  for(let i=0;i<a.length;i++) {
    const next=[i+1];for(let j=0;j<b.length;j++)next.push(Math.min(next[j]+1,previous[j+1]+1,previous[j]+(a[i]===b[j]?0:1)));
    previous=next;
  }return previous[b.length];
}
const rows=[];
try {
for(const item of manifest.cases) {
  if(typeof item.id!=='string'||typeof item.audio!=='string'||typeof item.commandExpected!=='boolean')throw new Error('Invalid case');
  const file=resolve(dirname(manifestPath),item.audio);
  for(const [variant,settings] of Object.entries(config.variants)) {
    const start=performance.now();let text='',error;
    try{text=await transcribeDeviceAudio(file,settings);}catch(e){error=String(e.message??e);}
    const command=personalVoiceCommand(text);
    const reference=typeof item.expectedText==='string'?normalize(personalVoiceCommand(item.expectedText)):null;
    rows.push({id:item.id,kind:item.kind,variant,expectedCommand:item.commandExpected,accepted:!!command,
      text,error,ms:Math.round(performance.now()-start),
      ...(reference?{characterEdits:edits([...reference],[...normalize(command)]),referenceCharacters:[...reference].length}:{})});
  }
}
} finally { stopFoundationModelsHelper(); }
const summary=Object.keys(config.variants).map(variant=>{
  const r=rows.filter(x=>x.variant===variant), negatives=r.filter(x=>!x.expectedCommand), positives=r.filter(x=>x.expectedCommand);
  const ref=r.filter(x=>x.referenceCharacters);
  return {variant,cases:r.length,negativeCases:negatives.length,falseAccepts:negatives.filter(x=>x.accepted).length,
    positiveCases:positives.length,falseRejects:positives.filter(x=>!x.accepted).length,
    errors:r.filter(x=>x.error && x.error!=='No speech detected').length,
    characterErrorRate:ref.length?ref.reduce((s,x)=>s+x.characterEdits,0)/ref.reduce((s,x)=>s+x.referenceCharacters,0):null,
    medianMs:r.map(x=>x.ms).sort((a,b)=>a-b)[Math.floor(r.length/2)]};
});
await writeFile(reportPath,JSON.stringify({label:manifest.label,generatedAt:new Date().toISOString(),summary,rows},null,2)+'\n');
console.log(JSON.stringify(summary,null,2));

if (gateVariant) {
  const gate=summary.find(s=>s.variant===gateVariant);
  if(!gate)throw new Error(`Unknown gate variant: ${gateVariant}`);
  if(gate.falseAccepts || gate.falseRejects || gate.errors)process.exitCode=2;
}
