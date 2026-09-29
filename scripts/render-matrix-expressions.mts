/** Actual production-renderer previews; no browser/backend/hardware required. */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { MATRIX_KINDS, MATRIX_RULES, MatrixExpression, type MatrixScene } from '../shared/src/index.js';
import { renderMatrixScene } from '../bridge/src/pixoo/matrix-art.js';
const output = path.resolve(process.argv[2] ?? 'diagnostics/matrix');
fs.mkdirSync(output, { recursive: true });
const face = MATRIX_KINDS.map(kind => ({ label: kind, size: 11 as const,
  frames: Array.from({ length: 8 }, (_, frame) => renderMatrixScene(11, { kind, count: 1, glyph: 'summary', frame, counts: [0, 1, 0, 1], roster: ['working'] })) }));
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
let svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="690"><rect width="1280" height="690" fill="rgb(12,13,16)"/><g fill="rgb(226,232,240)" font-family="monospace">';
svg += '<text x="24" y="32" font-size="22">Timebox Mini · expressive face</text>';
for (let i = 0; i < face.length; i++) {
  const tile = face[i]; const x = 24 + i * 179;
  svg += `<text x="${x}" y="64" font-size="16">${tile.label}</text>`;
  for (const [pose, y] of [[0, 80], [6, 224]]) {
    const png = await sharp(Buffer.from(tile.frames[pose]), { raw: { width: 11, height: 11, channels: 3 } }).resize(132, 132, { kernel: 'nearest' }).png().toBuffer();
    svg += `<image x="${x}" y="${y}" width="132" height="132" href="data:image/png;base64,${png.toString('base64')}"/>`;
  }
}
svg += '<text x="24" y="395" font-size="22">iDotMatrix · information first, event scenes second</text>';
for (let i = 0; i < world.length; i++) {
  const tile = world[i]; const x = 24 + i * 315;
  const png = await sharp(Buffer.from(tile.frames[3]), { raw: { width: 32, height: 32, channels: 3 } }).resize(224, 224, { kernel: 'nearest' }).png().toBuffer();
  svg += `<text x="${x}" y="428" font-size="15">${tile.label}</text><image x="${x}" y="445" width="224" height="224" href="data:image/png;base64,${png.toString('base64')}"/>`;
}
svg += '</g></svg>';
await sharp(Buffer.from(svg)).png().toFile(path.join(output, 'matrix-expressions.png'));
const json = tiles.map(t => ({ ...t, frames: t.frames.map(f => Buffer.from(f).toString('base64')) }));
fs.writeFileSync(path.join(output, 'matrix-expressions.html'), `<!doctype html><meta charset="utf-8"><title>AgentDeck matrix expressions</title><style>
body{background:rgb(12,13,16);color:rgb(226,232,240);font-family:monospace;padding:24px}main{display:flex;flex-wrap:wrap;gap:24px}figure{margin:0;padding:16px;background:rgb(20,24,32)}canvas{image-rendering:pixelated;width:220px;height:220px}figcaption{margin-bottom:12px}button{padding:12px}</style>
<h1>AgentDeck · expressive matrices</h1><p>Production-renderer frames. Face poses above; fleet information and event-only creature scenes below. Event clips loop here for inspection; on the device they expire after six seconds.</p><button id="pause">Pause</button><main></main><script>
const tiles=${JSON.stringify(json)};let tick=0,paused=false;const views=tiles.map(t=>{const f=document.createElement('figure');const l=document.createElement('figcaption');l.textContent=t.label;const c=document.createElement('canvas');c.width=c.height=t.size;f.append(l,c);document.querySelector('main').append(f);return{t,c}});
function draw(){for(const{t,c}of views){const data=atob(t.frames[tick%t.frames.length]),rgba=new Uint8ClampedArray(t.size*t.size*4);for(let p=0;p<t.size*t.size;p++){for(let k=0;k<3;k++)rgba[p*4+k]=data.charCodeAt(p*3+k);rgba[p*4+3]=255}c.getContext('2d').putImageData(new ImageData(rgba,t.size,t.size),0,0)}}draw();setInterval(()=>{if(!paused){tick++;draw()}},${MATRIX_RULES.frameMs});document.getElementById('pause').onclick=e=>{paused=!paused;e.target.textContent=paused?'Play':'Pause'};</script>`);
console.log(output);
