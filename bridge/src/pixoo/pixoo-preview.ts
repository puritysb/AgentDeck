/**
 * Pixoo live-preview helpers shared by the daemon (`daemon-server.ts`) and the
 * managed session bridge (`hook-server.ts`): a raw-RGB → BMP encoder for the
 * `/pixoo/frame` and `/pixoo/stream` routes, and the `/pixoo` HTML page.
 *
 * Kept out of `hook-server.ts` so the daemon does not import the managed
 * HookServer module (express + managed hook harness) just for these (#273).
 */
import { STATE_COLORS } from '@agentdeck/shared';

// Canonical state→color map for the inline page, with UPPERCASE aliases since
// the page keys on upper-cased state names.
const STATE_COLORS_JS = JSON.stringify(Object.fromEntries(
  Object.entries(STATE_COLORS).flatMap(([k, v]) => [[k, v], [k.toUpperCase(), v]]),
));

// ─── BMP Generator (24-bit uncompressed) ────────────────────────────────────

/** Convert raw RGB buffer to 24-bit BMP. Rows flipped + BGR byte order. */
export function rgbToBmp(rgb: Uint8Array, w: number, h: number): Buffer {
  const rowBytes = w * 3;
  // BMP rows must be padded to 4-byte boundary
  const rowPad = (4 - (rowBytes % 4)) % 4;
  const paddedRow = rowBytes + rowPad;
  const imageSize = paddedRow * h;
  const fileSize = 54 + imageSize;
  const buf = Buffer.alloc(fileSize);

  // File header (14 bytes)
  buf[0] = 0x42; buf[1] = 0x4D; // "BM"
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(54, 10); // pixel data offset

  // Info header (40 bytes)
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26);  // planes
  buf.writeUInt16LE(24, 28); // bpp
  buf.writeUInt32LE(imageSize, 34);

  // Pixel data (bottom-to-top, BGR)
  for (let y = 0; y < h; y++) {
    const srcRow = (h - 1 - y) * w * 3;
    const dstRow = 54 + y * paddedRow;
    for (let x = 0; x < w; x++) {
      const si = srcRow + x * 3;
      const di = dstRow + x * 3;
      buf[di] = rgb[si + 2];     // B
      buf[di + 1] = rgb[si + 1]; // G
      buf[di + 2] = rgb[si];     // R
    }
  }

  return buf;
}

// ─── Pixoo Live Preview HTML ────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c);
}

export function pixooLiveHtml(
  meta: { agentType?: string; projectName?: string },
  initialFps: number = 10,
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pixoo Live — ${escapeHtml(meta.projectName || 'AgentDeck')}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a0a;color:#e2e8f0;font-family:system-ui,-apple-system,sans-serif;
  display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:20px}
h1{font-size:14px;color:#64748b;letter-spacing:1px;text-transform:uppercase}
.frame-box{position:relative;border-radius:12px;overflow:hidden;
  box-shadow:0 0 40px rgba(59,130,246,0.15),0 0 80px rgba(59,130,246,0.05)}
canvas{display:block;image-rendering:pixelated;image-rendering:crisp-edges}
.hud{display:flex;gap:20px;font-size:12px;color:#64748b}
.hud .val{color:#94a3b8;font-weight:600}
.state-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px;vertical-align:middle}
.controls{display:flex;gap:8px;flex-wrap:wrap;justify-content:center}
.controls button{background:#1e293b;color:#94a3b8;border:1px solid #334155;border-radius:6px;
  padding:4px 12px;font-size:11px;cursor:pointer;transition:all 0.15s}
.controls button:hover{background:#334155;color:#e2e8f0}
.controls button.active{background:#3b82f6;color:#fff;border-color:#3b82f6}
.sep{width:1px;background:#334155;margin:0 4px}
.paused canvas{opacity:0.4}
</style>
</head>
<body>
<h1>Pixoo 64×64 Live Preview</h1>
<div class="frame-box" id="framebox">
  <canvas id="cv" width="512" height="512"></canvas>
</div>
<div class="hud">
  <span><span class="state-dot" id="dot"></span><span class="val" id="state">—</span></span>
  <span>FPS <span class="val" id="fps">0</span></span>
  <span>Frame <span class="val" id="fnum">0</span></span>
  <span>Scale <span class="val" id="scaleLabel">8×</span></span>
  <span>Preview <span class="val" id="previewFpsLabel">${initialFps}</span> FPS</span>
</div>
<div class="controls">
  <button id="btnPause">Pause</button>
  <div class="sep"></div>
  <button id="btn4" data-s="4">4×</button>
  <button id="btn8" data-s="8" class="active">8×</button>
  <button id="btn12" data-s="12">12×</button>
  <div class="sep"></div>
  <button class="fps-btn${initialFps===1?' active':''}" data-fps="1">1 FPS</button>
  <button class="fps-btn${initialFps===2?' active':''}" data-fps="2">2 FPS</button>
  <button class="fps-btn${initialFps===5?' active':''}" data-fps="5">5 FPS</button>
  <button class="fps-btn${initialFps===10?' active':''}" data-fps="10">10 FPS</button>
</div>

<script>
const cv=document.getElementById('cv');
const ctx=cv.getContext('2d');
const dot=document.getElementById('dot');
const $state=document.getElementById('state');
const $fps=document.getElementById('fps');
const $fnum=document.getElementById('fnum');
const $scale=document.getElementById('scaleLabel');
const $previewFpsLabel=document.getElementById('previewFpsLabel');
const framebox=document.getElementById('framebox');

let scale=8, paused=false, frameNum=0;
let lastTime=performance.now(), frameCount=0, displayFps=0;

// Scale buttons
document.querySelectorAll('.controls button[data-s]').forEach(btn=>{
  btn.addEventListener('click',()=>{
    scale=parseInt(btn.dataset.s);
    cv.width=64*scale; cv.height=64*scale;
    $scale.textContent=scale+'×';
    document.querySelectorAll('.controls button[data-s]').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
  });
});

// Pause
document.getElementById('btnPause').addEventListener('click',function(){
  paused=!paused;
  this.textContent=paused?'Resume':'Pause';
  framebox.classList.toggle('paused',paused);
});

// FPS buttons
function setActiveFpsBtn(fps){
  document.querySelectorAll('.fps-btn').forEach(b=>{
    b.classList.toggle('active', parseInt(b.dataset.fps)===fps);
  });
  $previewFpsLabel.textContent=fps;
}
document.querySelectorAll('.fps-btn').forEach(btn=>{
  btn.addEventListener('click',async()=>{
    const fps=parseInt(btn.dataset.fps);
    try{
      const r=await fetch('/pixoo/preview-fps',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({fps})
      });
      const d=await r.json();
      setActiveFpsBtn(d.fps||fps);
    }catch(e){
      console.error('FPS change failed',e);
    }
  });
});

// State colors
const stateColors=${STATE_COLORS_JS};

// SSE for state info
const es=new EventSource('/sse');
es.addEventListener('state_update',e=>{
  const d=JSON.parse(e.data);
  const s=d.state||'IDLE';
  $state.textContent=s;
  dot.style.background=stateColors[s]||stateColors.disconnected;
});

// SSE frame stream
const stream=new EventSource('/pixoo/stream');
stream.addEventListener('frame',function(e){
  if(paused) return;
  const img=new Image();
  img.onload=function(){
    ctx.imageSmoothingEnabled=false;
    ctx.drawImage(img,0,0,cv.width,cv.height);
    frameNum++;
    $fnum.textContent=frameNum;

    // FPS calc
    frameCount++;
    const now=performance.now();
    if(now-lastTime>=1000){
      displayFps=frameCount;
      frameCount=0;
      lastTime=now;
      $fps.textContent=displayFps;
    }
  };
  img.src='data:image/bmp;base64,'+e.data;
});
</script>
</body>
</html>`;
}
