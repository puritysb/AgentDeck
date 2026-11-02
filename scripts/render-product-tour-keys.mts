// Developer media only: call production renderers with fictional state.
// Enlarged output is not a hardware photograph or execution receipt.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { makeTourScene } from './product-tour-fixture.mjs';
import { renderSessionSlot, renderOptionButton } from '../shared/src/svg-renderers/session-slot-renderer.js';
import { buildSessionDeck } from '../shared/src/d200h-layout.js';
import { renderUsageEncoderBoth } from '../plugin/src/renderers/usage-gauge.js';
const require = createRequire(new URL('../plugin-ulanzi/package.json', import.meta.url));
const { initWasm, Resvg } = require('@resvg/resvg-wasm');
await initWasm(readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm')));
const fontBuffers = ['design/fonts/IBMPlexSansKR-Regular.ttf','design/fonts/IBMPlexSansKR-Bold.ttf'].map(p=>readFileSync(p));
const out = resolve(process.argv[2] || 'diagnostics/tour-raw');
mkdirSync(out,{recursive:true});
const raster = (name:string,svg:string) => writeFileSync(resolve(out,name+'.png'),new Resvg(svg,{font:{fontBuffers,defaultFontFamily:'IBM Plex Sans KR'},fitTo:{mode:'zoom',value:2}}).render().asPng());
const now=Date.now();
const scene = makeTourScene('overview',now);
const sessions = scene.find((e:any)=>e.type==='sessions_list').sessions;
const inner = (svg:string) => svg.replace(/^.*?<svg[^>]*>/s,'').replace(/<\/svg>\s*$/,'');
const wrap = (w:number,h:number,s:string) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${s}</svg>`;
raster('07-deck-keys',wrap(616,304,sessions.slice(0,7).map((s:any,i:number)=>`<svg x="${i%4*156}" y="${Math.floor(i/4)*156}" width="144" height="144" viewBox="0 0 144 144">${inner(renderSessionSlot(s,false,12,undefined,{animated:false}))}</svg>`).join('')));
raster('08-native-options',wrap(616,144,['Local demo','Skip verification','Allow once','Deny'].map((label,i)=>`<svg x="${i*156}" width="144" height="144" viewBox="0 0 144 144">${inner(renderOptionButton({index:i,label},i))}</svg>`).join('')));
const usage = scene.find((e:any)=>e.type==='usage_update');
const state = {...scene[0],allSessions:sessions,...usage,daemonConnected:true};
const positions=Array.from({length:14},(_,i)=>`${i%5}_${Math.floor(i/5)}`);
const deck=buildSessionDeck(state,{mode:'list',showUsage:true,animated:false},positions);
raster('09-d200h',wrap(780,468,[...deck].map(([pos,cell])=>{const [x,y]=pos.split('_').map(Number);return `<g transform="translate(${x*156} ${y*156})">${cell.svg}</g>`;}).join('')));
raster('10-usage-dial',renderUsageEncoderBoth({agent:'codex',title:'CODEX',fiveHour:{label:'5H',usedPercent:36,known:true,resetsAt:new Date(now+7200000).toISOString()},sevenDay:{label:'7D',usedPercent:58,known:true,resetsAt:new Date(now+259200000).toISOString()}}));
console.log('Production renderers, fictional data, no control commands executed.');

const controllable={...sessions.find((s:any)=>s.agentType==='openclaw'),state:'idle',controlMode:'managed',controllerInput:true,controllerAnswerable:true,liveAnswerable:true};
const detailState={...controllable,sessionId:controllable.id,allSessions:[controllable],daemonConnected:true};
const detail=buildSessionDeck(detailState,{mode:'detail',openSessionId:controllable.id,animated:false},positions);
raster('12-native-controls',wrap(780,468,[...detail].map(([pos,cell])=>{const [x,y]=pos.split('_').map(Number);return `<g transform="translate(${x*156} ${y*156})">${cell.svg}</g>`;}).join('')));
