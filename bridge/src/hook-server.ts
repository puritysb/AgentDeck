import express from 'express';
import { createServer, type Server, type ServerResponse } from 'http';
import { EventEmitter } from 'events';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFileSync, unlinkSync } from 'fs';
import { debug } from './logger.js';
import { isLocalConnection, validateToken } from './auth.js';
import type { BridgeEvent } from './types.js';
import type { VoiceManager } from './voice.js';
import { onFrameRendered, offFrameRendered, setPreviewFps, getPreviewFps } from './pixoo/pixoo-bridge.js';

/** Minimal SSE client handle */
interface SseClient {
  res: ServerResponse;
  id: number;
}

export class HookServer extends EventEmitter {
  private app: express.Application;
  private server: Server;
  private diagHandler: ((tail?: number) => unknown) | null = null;
  private voiceManager: VoiceManager | null = null;
  private apiUsageGetter: (() => { usage: unknown; fetchedAt: number }) | null = null;
  private deviceInfoGetter: (() => unknown) | null = null;
  private pixooFrameGetter: ((size?: 11 | 32 | 64, layout?: 'standard' | 'micro') => Uint8Array) | null = null;
  private pixooStreamListener: ((frame: Uint8Array) => void) | null = null;

  // SSE
  private sseClients: SseClient[] = [];
  private sseHeartbeats: Map<number, ReturnType<typeof setInterval>> = new Map();
  private pixooStreamTimers: Set<ReturnType<typeof setInterval>> = new Set();
  private sseIdCounter = 0;
  private lastStateEvent: BridgeEvent | null = null;
  private lastUsageEvent: BridgeEvent | null = null;

  // Metadata for status page / health
  private meta: { agentType?: string; projectName?: string; clientCount?: number; state?: string; modelName?: string; effortLevel?: string } = {};

  constructor() {
    super();
    this.app = express();
    this.app.use(express.json());
    this.setupRoutes();
    this.server = createServer(this.app);
  }

  /** Register a callback that provides diagnostic dump data */
  onDiag(handler: (tail?: number) => unknown): void {
    this.diagHandler = handler;
  }

  /** Update metadata shown on /health and /status */
  setMeta(meta: { agentType?: string; projectName?: string; clientCount?: number; state?: string; modelName?: string; effortLevel?: string }): void {
    Object.assign(this.meta, meta);
  }

  /** Set voice manager for /voice/transcribe endpoint */
  setVoiceManager(vm: VoiceManager): void {
    this.voiceManager = vm;
  }

  /** Register a getter for cached API usage data (exposed via GET /usage) */
  onApiUsage(getter: () => { usage: unknown; fetchedAt: number }): void {
    this.apiUsageGetter = getter;
  }

  /** Register a getter for connected device info (exposed via GET /devices) */
  setDeviceInfoGetter(getter: () => unknown): void {
    this.deviceInfoGetter = getter;
  }

  /** Register a getter that returns the current Pixoo RGB frame. */
  setPixooFrameGetter(getter: (size?: 11 | 32 | 64, layout?: 'standard' | 'micro') => Uint8Array): void {
    this.pixooFrameGetter = getter;
  }

  /** Broadcast a BridgeEvent to all SSE clients */
  broadcastSse(event: BridgeEvent): void {
    // Cache latest events for new SSE connections
    if (event.type === 'state_update') this.lastStateEvent = event;
    if (event.type === 'usage_update') this.lastUsageEvent = event;

    const data = JSON.stringify(event);
    const msg = `event: ${event.type}\ndata: ${data}\n\n`;
    const dead: number[] = [];

    for (const client of this.sseClients) {
      try {
        client.res.write(msg);
      } catch {
        dead.push(client.id);
      }
    }

    if (dead.length > 0) {
      this.sseClients = this.sseClients.filter((c) => !dead.includes(c.id));
      debug('SSE', `Removed ${dead.length} dead clients, ${this.sseClients.length} remaining`);
    }
  }

  /** Check token auth for a request. Returns true if authorized. */
  private checkAuth(req: express.Request, res: express.Response): boolean {
    const ip = req.ip || req.socket.remoteAddress || '';
    if (isLocalConnection(ip)) return true;
    const token = req.query.token as string | undefined;
    if (token && validateToken(token)) return true;
    res.status(401).json({ error: 'Unauthorized — token required' });
    return false;
  }

  private setupRoutes(): void {
    // Health check (no auth — minimal info)
    this.app.get('/health', (_req, res) => {
      debug('Hook', 'GET /health');
      res.json({
        status: 'ok',
        mode: this.meta.agentType,
        uptime: process.uptime(),
        agentType: this.meta.agentType,
        projectName: this.meta.projectName,
        state: this.meta.state,
        modelName: this.meta.modelName,
        effortLevel: this.meta.effortLevel,
        wsClients: this.meta.clientCount ?? 0,
        sseClients: this.sseClients.length,
      });
    });

    // Usage data endpoint (local only, no auth — daemon relays from sibling bridges)
    this.app.get('/usage', (_req, res) => {
      debug('Hook', 'GET /usage');
      if (!this.apiUsageGetter) {
        res.json({ status: 'ok', usage: null, fetchedAt: 0 });
        return;
      }
      const data = this.apiUsageGetter();
      res.json({ status: 'ok', usage: data.usage, fetchedAt: data.fetchedAt });
    });

    // Device info endpoint (no auth — local diagnostics)
    this.app.get('/devices', (_req, res) => {
      debug('Hook', 'GET /devices');
      res.json(this.deviceInfoGetter ? this.deviceInfoGetter() : { devices: [] });
    });

    // SSE endpoint
    this.app.get('/sse', (req, res) => {
      if (!this.checkAuth(req, res)) return;

      debug('SSE', 'New SSE client connected');

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.on('error', () => {}); // Prevent unhandled stream error on client disconnect

      const id = ++this.sseIdCounter;
      this.sseClients.push({ res, id });

      // Send current state snapshot
      try {
        if (this.lastStateEvent) {
          const data = JSON.stringify(this.lastStateEvent);
          res.write(`event: ${this.lastStateEvent.type}\ndata: ${data}\n\n`);
        }
        if (this.lastUsageEvent) {
          const data = JSON.stringify(this.lastUsageEvent);
          res.write(`event: ${this.lastUsageEvent.type}\ndata: ${data}\n\n`);
        }
      } catch { /* client disconnected before initial state sent */ }

      // Keep-alive heartbeat
      const heartbeat = setInterval(() => {
        try { res.write(':heartbeat\n\n'); } catch { /* client gone */ }
      }, 30_000);
      this.sseHeartbeats.set(id, heartbeat);

      req.on('close', () => {
        clearInterval(heartbeat);
        this.sseHeartbeats.delete(id);
        this.sseClients = this.sseClients.filter((c) => c.id !== id);
        debug('SSE', `Client disconnected, ${this.sseClients.length} remaining`);
      });
    });

    // Status page — inline HTML
    this.app.get('/status', (req, res) => {
      if (!this.checkAuth(req, res)) return;

      const token = req.query.token as string || '';
      const sseUrl = token ? `/sse?token=${token}` : '/sse';

      debug('Hook', 'GET /status');
      res.type('html').send(statusPageHtml(sseUrl, this.meta));
    });

    // Diagnostic endpoint
    this.app.get('/diag', (req, res) => {
      debug('Hook', 'GET /diag');
      if (!this.diagHandler) {
        res.status(503).json({ error: 'Diagnostic system not initialized' });
        return;
      }
      const tail = req.query.tail ? parseInt(req.query.tail as string, 10) : undefined;
      try {
        const dump = this.diagHandler(tail);
        res.json(dump);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // Hook endpoint - receives JSON POST from Claude Code hooks
    // The hook script pipes stdin JSON to curl POST body
    this.app.post('/hooks/:eventName', (req, res) => {
      const eventName = req.params.eventName;
      const data = req.body || {};

      debug('Hook', `POST /hooks/${eventName} (${JSON.stringify(data).slice(0, 120)})`);

      this.emit('hook', { event: eventName, data });

      // Managed (`agentdeck claude`) sessions own a PTY that handles permission
      // prompts natively, so they never gate via the hook. The PreToolUse hook
      // script echoes our response to Claude's stdout, so reply with an EMPTY
      // body for PreToolUse (echo → nothing → Claude's normal/ PTY flow). All
      // other events ack as before.
      if (eventName === 'PreToolUse') {
        res.type('application/json').send('');
        return;
      }
      // Respond quickly so the hook doesn't block Claude
      res.json({ received: true });
    });

    // Voice transcription endpoint (accepts raw WAV body)
    this.app.post('/voice/transcribe',
      express.raw({ type: 'application/octet-stream', limit: '10mb' }),
      async (req, res) => {
        if (!this.checkAuth(req, res)) return;

        if (!this.voiceManager) {
          res.status(503).json({ error: 'Voice manager not available' });
          return;
        }

        const body = req.body as Buffer;
        if (!body || body.length < 100) {
          res.status(400).json({ error: 'Empty or too short audio data' });
          return;
        }

        debug('Hook', `POST /voice/transcribe (${body.length} bytes)`);

        // Save to temp file
        const tempFile = join(tmpdir(), `agentdeck-voice-remote-${Date.now()}.wav`);
        try {
          writeFileSync(tempFile, body);
          const text = await this.voiceManager.transcribeFile(tempFile);
          res.json({ text });
        } catch (err) {
          debug('Hook', `Transcription error: ${err}`);
          res.status(500).json({ error: String(err) });
        } finally {
          try { unlinkSync(tempFile); } catch { /* ignore */ }
        }
      },
    );

    // Pixoo live preview — SSE frame stream
    this.app.get('/pixoo/stream', (req, res) => {
      if (!this.pixooFrameGetter) {
        res.status(503).json({ error: 'Pixoo renderer not available' });
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.on('error', () => {}); // Prevent unhandled stream error on client disconnect

      const listener = (frame: Uint8Array) => {
        const bmp = rgbToBmp(frame, 64, 64);
        const b64 = bmp.toString('base64');
        try { res.write(`event: frame\ndata: ${b64}\n\n`); } catch { /* client gone */ }
      };
      onFrameRendered(listener);

      // Send current frame immediately
      const current = this.pixooFrameGetter!();
      listener(current);

      // Heartbeat — tracked so close() can clear it even if the client
      // hasn't disconnected yet (prevents zombie event loop handles).
      const heartbeat = setInterval(() => {
        try { res.write(':heartbeat\n\n'); } catch { /* */ }
      }, 30_000);
      this.pixooStreamTimers.add(heartbeat);

      req.on('close', () => {
        offFrameRendered(listener);
        clearInterval(heartbeat);
        this.pixooStreamTimers.delete(heartbeat);
      });
    });

    // Pixoo live preview — serves BMP of current frame
    this.app.get('/pixoo/frame', (req, res) => {
      if (!this.pixooFrameGetter) {
        res.status(503).json({ error: 'Pixoo renderer not available' });
        return;
      }
      const sizeParam = req.query?.size;
      const size: 11 | 32 | 64 = sizeParam === '11' ? 11 : sizeParam === '32' ? 32 : 64;
      const layout = req.query?.layout === 'micro' ? 'micro' : 'standard';
      const rgb = this.pixooFrameGetter(size, layout);
      const bmp = rgbToBmp(rgb, size, size);
      res.set({
        'Content-Type': 'image/bmp',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      res.send(bmp);
    });

    // Pixoo live preview HTML page
    this.app.get('/pixoo', (_req, res) => {
      debug('Hook', 'GET /pixoo');
      res.type('html').send(pixooLiveHtml(this.meta, getPreviewFps()));
    });

    // Pixoo preview FPS control
    this.app.post('/pixoo/preview-fps', (req, res) => {
      const fps = Number(req.body?.fps);
      if (!isFinite(fps) || fps < 1 || fps > 10) {
        res.status(400).json({ error: 'fps must be 1–10' });
        return;
      }
      setPreviewFps(fps);
      debug('Hook', `Preview FPS set to ${fps}`);
      res.json({ fps: getPreviewFps() });
    });

    // Catch-all for unknown routes
    this.app.use((req, res) => {
      debug('Hook', `404: ${req.method} ${req.url}`);
      res.status(404).json({ error: 'Not found' });
    });
  }

  async listen(port: number, host: string = '127.0.0.1'): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Port ${port} is already in use. Is another bridge instance running?`));
        } else {
          reject(err);
        }
      });

      this.server.listen(port, host, () => {
        debug('Hook', `listening on ${host}:${port}`);
        resolve();
      });
    });
  }

  getServer(): Server {
    return this.server;
  }

  async close(): Promise<void> {
    // Clear all SSE heartbeat intervals
    for (const interval of this.sseHeartbeats.values()) {
      clearInterval(interval);
    }
    this.sseHeartbeats.clear();

    // Clear Pixoo stream heartbeats
    for (const timer of this.pixooStreamTimers) {
      clearInterval(timer);
    }
    this.pixooStreamTimers.clear();

    // Close all SSE connections
    for (const client of this.sseClients) {
      try { client.res.end(); } catch { /* ignore */ }
    }
    this.sseClients = [];

    return new Promise((resolve) => {
      debug('Hook', 'closing server');
      // Destroy all active connections so server.close() resolves immediately
      this.server.closeAllConnections();
      this.server.close(() => {
        resolve();
      });
      // Fallback: resolve after 1s even if server.close() hangs.
      // .unref() so this timer doesn't keep the event loop alive as a zombie.
      setTimeout(resolve, 1000).unref();
    });
  }
}

// ─── Inline Status Page HTML ──────────────────────────────────────────────────

function statusPageHtml(
  sseUrl: string,
  meta: { agentType?: string; projectName?: string },
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AgentDeck — ${meta.projectName || 'Bridge'}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0f172a;color:#f8fafc;font-family:system-ui,-apple-system,sans-serif;padding:24px}
h1{font-size:20px;color:#94a3b8;margin-bottom:16px}
.card{background:#1e293b;border-radius:12px;padding:16px;margin-bottom:12px}
.label{color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:0.5px}
.value{font-size:24px;font-weight:600;margin-top:4px}
.row{display:flex;gap:12px;flex-wrap:wrap}
.row .card{flex:1;min-width:140px}
.state-IDLE{color:#22c55e}
.state-PROCESSING{color:#3b82f6}
.state-AWAITING_PERMISSION,.state-AWAITING_OPTION,.state-AWAITING_DIFF{color:#f59e0b}
.state-DISCONNECTED{color:#ef4444}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:8px;vertical-align:middle}
.banner{text-align:center;color:#64748b;font-size:12px;margin-top:24px}
.banner a{color:#3b82f6;text-decoration:none}
</style>
</head>
<body>
<h1>AgentDeck${meta.projectName ? ' — ' + esc(meta.projectName) : ''}</h1>
<div class="row">
  <div class="card"><div class="label">State</div><div class="value" id="state">—</div></div>
  <div class="card"><div class="label">Agent</div><div class="value" id="agent">${esc(meta.agentType || '—')}</div></div>
</div>
<div class="row">
  <div class="card"><div class="label">Model</div><div class="value" id="model">—</div></div>
  <div class="card"><div class="label">Tool</div><div class="value" id="tool">—</div></div>
</div>
<div class="row">
  <div class="card"><div class="label">Session</div><div class="value" id="session">0:00</div></div>
  <div class="card"><div class="label">Tokens</div><div class="value" id="tokens">—</div></div>
  <div class="card"><div class="label">Cost</div><div class="value" id="cost">—</div></div>
</div>
<div class="banner">AgentDeck Bridge &middot; <a href="https://github.com/agentdeck">GitHub</a></div>

<script>
const es=new EventSource("${sseUrl}");
const $=id=>document.getElementById(id);
const colors={IDLE:'#22c55e',PROCESSING:'#3b82f6',AWAITING_PERMISSION:'#f59e0b',AWAITING_OPTION:'#f59e0b',AWAITING_DIFF:'#f59e0b',DISCONNECTED:'#ef4444'};
es.addEventListener('state_update',e=>{
  const d=JSON.parse(e.data);
  const s=d.state||'DISCONNECTED';
  $('state').innerHTML='<span class="dot" style="background:'+( colors[s]||'#64748b')+'"></span>'+s;
  if(d.modelName)$('model').textContent=d.modelName;
  $('tool').textContent=d.currentTool||'—';
});
es.addEventListener('usage_update',e=>{
  const d=JSON.parse(e.data);
  const m=Math.floor(d.sessionDurationSec/60),s=d.sessionDurationSec%60;
  $('session').textContent=m+':'+(s<10?'0':'')+s;
  const t=(d.inputTokens||0)+(d.outputTokens||0);
  $('tokens').textContent=t>1000?(t/1000).toFixed(1)+'k':t;
  $('cost').textContent=d.estimatedCostUsd?'$'+d.estimatedCostUsd.toFixed(2):'—';
});
</script>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c);
}

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

export function pixooLiveHtml(
  meta: { agentType?: string; projectName?: string },
  initialFps: number = 10,
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pixoo Live — ${meta.projectName || 'AgentDeck'}</title>
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
const stateColors={IDLE:'#22c55e',PROCESSING:'#3b82f6',
  AWAITING_OPTION:'#f59e0b',AWAITING_PERMISSION:'#f59e0b',AWAITING_DIFF:'#f59e0b',
  DISCONNECTED:'#ef4444'};

// SSE for state info
const es=new EventSource('/sse');
es.addEventListener('state_update',e=>{
  const d=JSON.parse(e.data);
  const s=d.state||'IDLE';
  $state.textContent=s;
  dot.style.background=stateColors[s]||'#64748b';
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
