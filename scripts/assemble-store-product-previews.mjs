#!/usr/bin/env node
// Developer media preparation only. No Store upload or version changes.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const raw=resolve(process.argv[2]||'diagnostics');
const controls=resolve(process.argv[3]||'diagnostics/media-2.0/4100e0ca');
const scratch=resolve(raw,'store-assembly');mkdirSync(scratch,{recursive:true});
const json=p=>JSON.parse(readFileSync(p,'utf8'));
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const run=args=>{const p=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-y',...args],{stdio:'inherit'});if(p.status!==0)throw Error(`ffmpeg ${p.status}`);};
const phone=json(resolve(raw,'phone/run.json'));
const log=readFileSync(resolve(raw,'phone/ui-test.log'),'utf8');
const cue=name=>Number(log.match(new RegExp(`TOUR_CUE ${name} ([0-9.]+)`))[1])-phone.recordRequestedAt+.3;
const control=(platform)=>{const meta=json(resolve(controls,platform,'clip.json'));return {file:resolve(controls,platform,'original.mov'),start:meta.start+4,duration:meta.duration-4,proof:'Real local OpenCode execution, original choice, one-time approval and resumed result'};};
const plans=[
 {platform:'iPhone',size:[886,1920],clips:[{file:resolve(raw,'phone/original.mov'),start:cue('phone-overview'),duration:3.5,proof:'Native multi-agent session roster, fictional activity'},{file:resolve(raw,'phone/original.mov'),start:cue('phone-system'),duration:4,proof:'Native usage/system view, fictional account quota'},control('iphone')]},
 {platform:'iPad',size:[1600,1200],clips:[{file:resolve(raw,'tour-raw/14-tablet-default.mov'),start:0,duration:8,proof:'Native iPad multi-agent dashboard, timeline and usage, fictional activity'},control('ipad')]},
 {platform:'macOS',size:[1920,1080],clips:[{file:resolve(raw,'tour-raw/01-overview.mov'),start:1,duration:5,proof:'Native Mac multi-agent dashboard, fictional activity'},{file:resolve(raw,'tour-raw/04-graph.mov'),start:1,duration:6,proof:'Native expanded Collaboration Beta graph, fictional observed messages'},control('macos')]},
];
const result=[];
for(const plan of plans.filter(p=>!process.argv[4]||process.argv[4]===p.platform)){

 const [w,h]=plan.size;let at=0;const clips=[];
 for(const [i,c] of plan.clips.entries()){
  const path=resolve(scratch,`${plan.platform}-${i}.mp4`);
  run(['-ss',String(c.start),'-i',c.file,'-t',String(c.duration),'-vf',`fps=30,scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1`,'-an','-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p',path]);
  clips.push(path);c.startInPreview=at;at+=Math.round(c.duration*30)/30;c.sha256=sha(c.file);
 }
 if(at<15||at>30)throw Error(`Invalid Store duration ${at}`);
 const list=resolve(scratch,`${plan.platform}.txt`);writeFileSync(list,clips.map(p=>`file '${p.replaceAll("'","'\\''")}'`).join('\n'));
 const output=resolve(root,`apple/appstore-submission/previews/${plan.platform}/agentdeck-preview.mp4`);
 run(['-f','concat','-safe','0','-i',list,'-f','lavfi','-i','anullsrc=r=44100:cl=stereo','-map','0:v','-map','1:a','-t',String(at),'-c:v','libx264','-preset','fast','-profile:v','high','-level:v','4.0','-b:v','11M','-minrate','11M','-maxrate','11M','-bufsize','22M','-x264-params','nal-hrd=cbr:force-cfr=1','-pix_fmt','yuv420p','-r','30','-c:a','aac','-b:a','256k','-ar','44100','-ac','2','-movflags','+faststart',output]);
 result.push({platform:plan.platform,file:output,duration:at,sha256:sha(output),size:plan.size,clips:plan.clips});console.log(`${plan.platform}: ${at}s; local candidate only`);
}
const previousPath=resolve(raw,'store-product-preview-cuts.json');
if(process.argv[4]) {const previous=JSON.parse(readFileSync(previousPath,'utf8'));for(const item of previous)if(!result.some(r=>r.platform===item.platform))result.push(item);}
writeFileSync(previousPath,JSON.stringify(result,null,2)+'\n');
