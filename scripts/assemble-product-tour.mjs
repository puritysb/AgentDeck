#!/usr/bin/env node
// Deterministic editorial assembly. Native UI pixels are only cut, cropped,
// aspect-fit and placed on a labeled chapter canvas; no UI is invented here.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const raw=resolve(process.argv[2]||resolve(root,'diagnostics/tour-raw'));
const out=resolve(process.argv[3]||resolve(root,'docs/media/current'));
const scratch=resolve(raw,'assembly');mkdirSync(scratch,{recursive:true});mkdirSync(out,{recursive:true});
const story=JSON.parse(readFileSync(resolve(root,'scripts/product-tour-story.json'),'utf8'));
const require=createRequire(resolve(root,'plugin-ulanzi/package.json'));
const {initWasm,Resvg}=require('@resvg/resvg-wasm');
await initWasm(readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm')));
const fontBuffers=['IBMPlexSansKR-Regular.ttf','IBMPlexSansKR-Bold.ttf'].map(p=>readFileSync(resolve(root,'design/fonts',p)));
const css=readFileSync(resolve(root,'design/tokens.css'),'utf8');
const token=name=>{const value=css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]+)`))?.[1];if(!value)throw new Error(`Missing token ${name}`);return value;};
const ink=token('ink-900'),tide=token('tide-50'),muted=token('tide-300'),accent=token('kelp-300');
const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const inputPath=file=>file.startsWith('raw/')?resolve(raw,file.slice(4)):file.startsWith('current/')?resolve(out,file.slice(8)):file.startsWith('repo/')?resolve(root,file.slice(5)):(()=>{throw new Error(`Unsupported source ${file}`);})();
function run(args){const p=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-y',...args],{stdio:'inherit'});if(p.status!==0)throw new Error(`ffmpeg failed (${p.status})`);}
const duration=path=>{const p=spawnSync('ffprobe',['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',path],{encoding:'utf8'});if(p.status!==0)throw new Error('ffprobe failed');return Number(p.stdout);};
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const cuts=[];let at=0;
for(const [index,c] of story.chapters.entries()){
 const frame=resolve(scratch,`${c.id}-frame.png`),clip=resolve(scratch,`${c.id}.mp4`);
 const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="${ink}"/><g font-family="IBM Plex Sans KR" fill="${tide}"><text x="40" y="34" font-size="22" fill="${accent}">AGENTDECK 2.0 · DEVELOPMENT PRODUCT TOUR · ${String(index+1).padStart(2,'0')} / ${story.chapters.length}</text><text x="40" y="100" font-weight="bold" font-size="52">${esc(c.title)}</text><text x="40" y="154" font-size="28">${esc(c.subtitle)}</text><text x="40" y="1002" font-size="21" fill="${muted}">${esc(c.proof)}</text></g><rect x="40" y="1025" width="1840" height="3" fill="${muted}"/><rect x="40" y="1025" width="${1840*(index+1)/story.chapters.length}" height="3" fill="${accent}"/></svg>`;
 writeFileSync(frame,new Resvg(svg,{font:{fontBuffers,defaultFontFamily:'IBM Plex Sans KR'}}).render().asPng());
 const args=['-loop','1','-framerate','30','-i',frame];
 for(const l of c.layers){if(/\.(png|jpg)$/.test(l.file))args.push('-loop','1','-framerate','30');else if(l.start)args.push('-ss',String(l.start));args.push('-i',inputPath(l.file));}
 let filter='[0:v]format=yuv420p[base0];';
 c.layers.forEach((l,i)=>{filter+=`[${i+1}:v]${l.crop?`crop=${l.crop[2]}:${l.crop[3]}:${l.crop[0]}:${l.crop[1]},`:''}scale=${l.w}:${l.h}:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,fps=30,setpts=PTS-STARTPTS[layer${i}];[base${i}][layer${i}]overlay=x=${l.x}+(${l.w}-overlay_w)/2:y=${l.y}+(${l.h}-overlay_h)/2:shortest=1[base${i+1}];`;});
 filter=filter.slice(0,-1);
 args.push('-filter_complex',filter,'-map',`[base${c.layers.length}]`,'-an','-t',String(c.duration),'-c:v','libx264','-preset','fast','-crf','21','-pix_fmt','yuv420p','-r','30','-movflags','+faststart',clip);run(args);
 if(Math.abs(duration(clip)-c.duration)>1/30+.001)throw new Error(`${c.id}: source ends before requested chapter duration`);
 cuts.push({id:c.id,start:at,end:at+c.duration,title:c.title,proof:c.proof,layers:c.layers.map(l=>({...l,sha256:hash(inputPath(l.file))}))});at+=c.duration;
 console.log(`${c.id}: ${c.duration}s`);
}
const list=resolve(scratch,'concat.txt');writeFileSync(list,story.chapters.map(c=>`file '${resolve(scratch,c.id+'.mp4').replaceAll("'","'\\''")}'`).join('\n'));
const video=resolve(out,'agentdeck-200-product-tour.mp4');run(['-f','concat','-safe','0','-i',list,'-c','copy','-movflags','+faststart',video]);
if(Math.abs(duration(video)-at)>1/30+.001)throw new Error('Film duration does not match chapter/caption clock');
function stamp(seconds){const ms=Math.round(seconds*1000);return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}.${String(ms%1000).padStart(3,'0')}`;}
for(const lang of ['en','ko','ja']){let t=0;const vtt=['WEBVTT',''];for(const c of story.chapters){vtt.push(`${stamp(t)} --> ${stamp(t+c.duration)}`,c[lang],'');t+=c.duration;}writeFileSync(resolve(out,`agentdeck-200-product-tour.${lang}.vtt`),vtt.join('\n'));}
run(['-ss','24','-i',video,'-frames:v','1',resolve(out,'agentdeck-200-product-tour-poster.jpg')]);
run(['-ss','20','-t','6','-i',video,'-vf','fps=8,scale=720:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse','-loop','0',resolve(out,'agentdeck-200-product-tour-preview.gif')]);
writeFileSync(resolve(out,'agentdeck-200-product-tour-cuts.json'),JSON.stringify({sourceRevision:story.sourceRevision,availability:'2.0 development candidate; not current Store release',duration:at,transformations:'Original speed; editorial cuts, labeled native crops, static product captures and production renderer frames. No synthetic UI execution.',videoSha256:hash(video),chapters:cuts},null,2)+'\n');
