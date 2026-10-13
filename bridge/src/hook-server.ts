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
import { STATE_COLORS } from '@agentdeck/shared';
import { ManagedHookGate, neutralHookReply, type ForeignHookForwarder, type ManagedHarness } from './managed-hook-harness.js';
import { rgbToBmp, pixooLiveHtml } from './pixoo/pixoo-preview.js';

// Canonical state→color map for the inline status pages, with UPPERCASE
// aliases since the pages historically key on upper-cased state names.
const STATE_COLORS_JS = JSON.stringify(Object.fromEntries(
  Object.entries(STATE_COLORS).flatMap(([k, v]) => [[k, v], [k.toUpperCase(), v]]),
));

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
  // Which hooks are this session's own is decided by their payload (#490).
  private ownHarness: ManagedHarness = 'claude-code';
  private readonly hookGate = new ManagedHookGate(() => this.ownHarness);
  private foreignHookForwarder: ForeignHookForwarder | null = null;

  constructor() {
    super();
    this.app = express();
    this.app.use(express.json());
    this.setupRoutes();
    this.server = createServer(this.app);
  }

  /** Whose hooks this bridge's session is made of. Set by the adapter before
   *  the port opens: hooks arrive the moment the PTY spawns. */
  setOwnHarness(harness: ManagedHarness): void {
    this.ownHarness = harness;
  }

  /** Where another harness's hooks go — the local daemon (see managed-hook-harness.ts). */
  setForeignHookForwarder(forwarder: ForeignHookForwarder | null): void {
    this.foreignHookForwarder = forwarder;
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

  /** Hand another harness's hook to the daemon and relay its answer, so a
   *  held decision still reaches the hook script; without a daemon the script
   *  gets the neutral reply and its agent continues on its own. */
  private async forwardForeignHook(eventName: string, body: string, pid: string | undefined, res: express.Response): Promise<void> {
    const reply = await this.foreignHookForwarder?.(eventName, body, pid ? { 'X-AgentDeck-Pid': pid } : {}) ?? null;
    if (res.headersSent) return;
    if (reply) res.status(reply.status).type(reply.contentType).send(reply.body);
    else res.type('application/json').send(neutralHookReply(eventName));
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
      // Numbers and their age travel together, or not at all. `fetchedAt` is
      // `BridgeCore.lastApiFetchTime`, which advances only on a LIVE reading —
      // so a bridge whose cache came from a failed fetch's fallback has numbers
      // with a 0 timestamp. This endpoint exists to be a relay SOURCE, and a
      // bridge that never completed a live fetch is not one: say so with an
      // explicit null rather than shipping unstamped values.
      //
      // Both relay consumers gate on a positive `fetchedAt` and neither handles
      // the pair {numbers, 0}: Node's fetchUsageViaHttp computes a huge age and
      // skips (harmless), but Swift's fetchUsageViaHTTP skips its whole
      // `fetchedAt > 0` block — dropping the age gate AND the key — so
      // parseRelayedUsage falls to `lastApiFetchTime = Date()` and stamps
      // unknown-age data as just-fetched. Closing it at the producer fixes both.
      if (!data.fetchedAt) {
        res.json({ status: 'ok', usage: null, fetchedAt: 0 });
        return;
      }
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
      const data = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;

      debug('Hook', `POST /hooks/${eventName} (${JSON.stringify(data).slice(0, 120)})`);

      // Serialized before classify(), which may add a Codex thread's session_id.
      const original = JSON.stringify(data);
      const verdict = this.hookGate.classify(eventName, data);
      if (verdict.kind === 'drop') {
        res.type('application/json').send(neutralHookReply(eventName, true));
        return;
      }
      if (verdict.kind === 'foreign') {
        void this.forwardForeignHook(eventName, original, req.get('X-AgentDeck-Pid'), res);
        return;
      }

      this.emit('hook', { event: verdict.eventName, data });

      // Managed (`agentdeck claude`) sessions own a PTY that handles permission
      // prompts natively, so they never gate via the hook. The PreToolUse and
      // Stop hook scripts echo our response to Claude's stdout, so reply with
      // an EMPTY body for both (echo → nothing → Claude's normal/PTY flow —
      // steering for managed sessions goes through the PTY, never the hook).
      // All other events ack as before.
      res.type('application/json').send(neutralHookReply(eventName, verdict.quiet));
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
const colors=${STATE_COLORS_JS};
es.addEventListener('state_update',e=>{
  const d=JSON.parse(e.data);
  const s=d.state||'DISCONNECTED';
  $('state').innerHTML='<span class="dot" style="background:'+( colors[s]||colors.disconnected)+'"></span>'+s;
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
