/** Actual production-renderer previews; no browser/backend/hardware required. */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { MATRIX_FACES, MATRIX_RULES, MatrixExpression, type MatrixScene } from '../shared/src/index.js';
import { renderMatrixScene } from '../bridge/src/pixoo/matrix-art.js';
const output = path.resolve(process.argv[2] ?? 'diagnostics/matrix');
fs.mkdirSync(output, { recursive: true });
// Population metadata must not introduce extra dots under the face.
const face = MATRIX_FACES.map(f => ({ label: f, size: 11 as const,
  frames: Array.from({ length: MATRIX_RULES.frames }, (_, frame) => renderMatrixScene(11, { kind: 'idle', face: f, pips: 2, count: 1, glyph: 'summary', frame, counts: [0, 1, 0, 1], roster: ['working'] })) }));
const engine = new MatrixExpression();
engine.updateSessions([{ id: 'c', alive: true, agentType: 'claude-code', state: 'processing' },
  { id: 'x', alive: true, agentType: 'codex-cli', state: 'idle' }], 0);
const base = engine.scene(0);
const scenes: [string, MatrixScene][] = [
  ['Fleet: two working', { ...base, kind: 'working', counts: [0, 2, 3, 4], roster: ['working', 'working', 'idle', 'idle'] }],
  ['Waiting + error', { ...base, kind: 'waiting', counts: [1, 2, 3, 1], roster: ['waiting', 'working', 'working', 'error'] }],
  ['New Claude session', { ...base, kind: 'arrival', glyph: 'claudeCode', count: 2 }],
  ['Codex response', { ...base, kind: 'done', glyph: 'codex', count: 1 }],
];
const world = scenes.map(([label, scene]) => ({ label, size: 32 as const,
  frames: Array.from({ length: 8 }, (_, frame) => renderMatrixScene(32, { ...scene, frame })) }));
const tiles = [...face, ...world];
const perRow = 8, faceRows = Math.ceil(face.length / perRow), rowH = 330, worldY = 50 + faceRows * rowH;
const height = worldY + 300;
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1460" height="${height}"><rect width="1460" height="${height}" fill="rgb(12,13,16)"/><g fill="rgb(226,232,240)" font-family="monospace">`;
svg += '<text x="24" y="32" font-size="22">Timebox Mini · expressive face</text>';
for (let i = 0; i < face.length; i++) {
  const tile = face[i]; const x = 24 + (i % perRow) * 179, top = Math.floor(i / perRow) * rowH;
  svg += `<text x="${x}" y="${top + 64}" font-size="16">${tile.label}</text>`;
  for (const [pose, y] of [[0, top + 80], [6, top + 224]]) {
    const png = await sharp(Buffer.from(tile.frames[pose]), { raw: { width: 11, height: 11, channels: 3 } }).resize(132, 132, { kernel: 'nearest' }).png().toBuffer();
    svg += `<image x="${x}" y="${y}" width="132" height="132" href="data:image/png;base64,${png.toString('base64')}"/>`;
  }
}
svg += `<text x="24" y="${worldY + 5}" font-size="22">iDotMatrix · information first, event scenes second</text>`;
for (let i = 0; i < world.length; i++) {
  const tile = world[i]; const x = 24 + i * 315;
  const png = await sharp(Buffer.from(tile.frames[3]), { raw: { width: 32, height: 32, channels: 3 } }).resize(224, 224, { kernel: 'nearest' }).png().toBuffer();
  svg += `<text x="${x}" y="${worldY + 38}" font-size="15">${tile.label}</text><image x="${x}" y="${worldY + 55}" width="224" height="224" href="data:image/png;base64,${png.toString('base64')}"/>`;
}
svg += '</g></svg>';
await sharp(Buffer.from(svg)).png().toFile(path.join(output, 'matrix-expressions.png'));
// A shareable, 4-bit-quantized sample at the CLI's nominal poll cadence.
// Left to right: quiet, hello, listening, working, speaking, result.
const stripFaces = ['idle', 'arrival', 'asked', 'working', 'reply', 'done'];
const scale = 8, stripW = stripFaces.length * 13 * scale, stripH = 13 * scale;
const strip = Buffer.alloc(stripW * stripH * 4 * 3);
for (let pose = 0; pose < 4; pose++) for (let tile = 0; tile < stripFaces.length; tile++) {
  const pixels = face.find(f => f.label === stripFaces[tile])!.frames[pose * 2];
  for (let y = 0; y < 11 * scale; y++) for (let x = 0; x < 11 * scale; x++) {
    const src = (Math.floor(y / scale) * 11 + Math.floor(x / scale)) * 3;
    const dst = ((pose * stripH + scale + y) * stripW + tile * 13 * scale + scale + x) * 3;
    for (let c = 0; c < 3; c++) strip[dst + c] = Math.round(pixels[src + c] / 17) * 17;
  }
}
await sharp(strip, { raw: { width: stripW, height: stripH * 4, channels: 3, pageHeight: stripH } })
  .gif({ delay: Array(4).fill(MATRIX_RULES.frameMs * 2), loop: 0, dither: 0 })
  .toFile(path.join(output, 'timebox-conversation.gif'));
const json = tiles.map(t => ({ ...t, frames: t.frames.map(f => Buffer.from(f).toString('base64')) }));
fs.writeFileSync(path.join(output, 'matrix-expressions.html'), `<!doctype html><meta charset="utf-8"><title>AgentDeck matrix expressions</title><style>
body{background:rgb(12,13,16);color:rgb(226,232,240);font-family:monospace;padding:24px}main{display:flex;flex-wrap:wrap;gap:24px}figure{margin:0;padding:16px;background:rgb(20,24,32)}canvas{image-rendering:pixelated;width:220px;height:220px}figcaption{margin-bottom:12px}button{padding:12px}</style>
<h1>AgentDeck · expressive matrices</h1><p>Production-renderer frames. Local visual preview only; buttons do not send commands to a device or agent. Event clips loop here for inspection; on the device they expire according to the scene policy.</p>
<figure><figcaption id="stage-label">At your desk</figcaption><canvas id="stage" width="11" height="11"></canvas></figure>
<p id="gestures"><button data-face="arrival">Say hello</button> <button data-face="asked">Send a message</button> <button data-face="working">Working</button> <button data-face="waiting">Needs approval</button> <button data-face="reply">Agent replies</button> <button data-face="idle">Quiet desk</button></p>
<p><button id="pause">Pause</button> <label>Sampling <select id="cadence"><option value="750">All frames · 750 ms</option><option value="1000">Swift tick · 1 s</option><option value="1500" selected>CLI poll · 1.5 s</option></select></label></p>
<main></main><script>
const tiles=${JSON.stringify(json)};let tick=0,paused=false;const views=tiles.map(t=>{const f=document.createElement('figure');const l=document.createElement('figcaption');l.textContent=t.label;const c=document.createElement('canvas');c.width=c.height=t.size;f.append(l,c);document.querySelector('main').append(f);return{t,c}});
const hero={t:tiles.find(t=>t.size===11&&t.label==='idle'),c:document.getElementById('stage')};
function draw(){for(const{t,c}of [...views,hero]){const data=atob(t.frames[tick%t.frames.length]),rgba=new Uint8ClampedArray(t.size*t.size*4);for(let p=0;p<t.size*t.size;p++){for(let k=0;k<3;k++){const v=data.charCodeAt(p*3+k);rgba[p*4+k]=t.size===11?Math.round(v/17)*17:v}rgba[p*4+3]=255}c.getContext('2d').putImageData(new ImageData(rgba,t.size,t.size),0,0)}}
let elapsed=0,timer;function schedule(){clearInterval(timer);const ms=Number(document.getElementById('cadence').value);timer=setInterval(()=>{if(!paused){elapsed+=ms;tick=Math.floor(elapsed/${MATRIX_RULES.frameMs});draw()}},ms)}
document.getElementById('gestures').onclick=e=>{const face=e.target.dataset.face;if(!face)return;hero.t=tiles.find(t=>t.size===11&&t.label===face);document.getElementById('stage-label').textContent=e.target.textContent;tick=0;elapsed=0;draw();schedule()};
draw();schedule();document.getElementById('cadence').onchange=schedule;document.getElementById('pause').onclick=e=>{paused=!paused;e.target.textContent=paused?'Play':'Pause'};</script>`);
console.log(output);
