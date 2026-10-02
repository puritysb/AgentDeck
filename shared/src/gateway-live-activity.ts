/** Gateway-observed activity. Never infer automation from a missing prompt.
 * Node and Swift replay the same captured Gateway frames; numeric bounds and
 * event vocabulary are mirrored by generate-gateway-live-rules.mjs. */
import type { TimelineEntry } from './timeline.js';

export const GATEWAY_LIVE_RULES = {
  maxRuns: 128, maxTools: 512, detailLimit: 1000, rawLimit: 200,
  terminalPhases: ['end', 'error', 'aborted'],
  activePhases: ['start', 'model', 'finishing'],
  quietProcessActions: ['poll', 'log', 'list'],
} as const;
type ObjectValue = Record<string, unknown>;
export const gatewayObject = (v: unknown): ObjectValue => v && typeof v === 'object' && !Array.isArray(v) ? v as ObjectValue : {};
const string = (v: unknown): string | undefined => typeof v === 'string' && v.trim() ? v : undefined;
export function gatewayMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map(v => gatewayObject(v)).filter(v => v.type === 'text').map(v => string(v.text) ?? '').join('') : '';
}
interface Run {
  sessionKey: string; runId?: string; startedAt: number; prompt?: string;
  response: string; closed: boolean; responseEmitted: boolean; automated: boolean;
}
interface Tool { name: string; input: unknown; ts: number; done: boolean }
export interface GatewayLiveUpdate { entry: TimelineEntry; upsert?: boolean }

export class GatewayLiveActivity {
  private runs = new Map<string, Run>();
  private tools = new Map<string, Tool>();
  private messages = new Map<string, boolean>();
  get busy(): boolean { return [...this.runs.values()].some(r => !r.closed); }
  reset(): void { this.runs.clear(); this.tools.clear(); this.messages.clear(); }
  private bounded<K,V>(map: Map<K,V>, max: number): void {
    while (map.size > max) map.delete(map.keys().next().value!);
  }
  private row(run: Run, type: TimelineEntry['type'], ts: number, raw: string, detail?: string): TimelineEntry {
    return { ts: Math.trunc(ts), type, raw: raw.slice(0, GATEWAY_LIVE_RULES.rawLimit),
      ...(detail ? { detail: detail.slice(0, GATEWAY_LIVE_RULES.detailLimit) } : {}),
      agentType: 'openclaw', projectName: 'OpenClaw', sessionId: 'openclaw-gateway',
      ...(run.runId ? { runId: run.runId } : {}), automated: run.automated,
      startedAt: run.startedAt };
  }
  dispatch(sessionKey: string, runId: string, prompt: string, now: number): GatewayLiveUpdate[] {
    this.ingest('chat', { sessionKey, runId, state: 'status' }, now);
    return this.ingest('session.message', { sessionKey, runId, message: { role: 'user', content: prompt } }, now);
  }
  ingest(event: string, payload: unknown, now: number): GatewayLiveUpdate[] {
    now = Math.trunc(now);
    const p = gatewayObject(payload), data = gatewayObject(p.data), message = gatewayObject(p.message);
    const session = gatewayObject(p.session), meta = gatewayObject(message.__openclaw);
    const sessionKey = string(p.sessionKey) ?? string(session.key);
    if (!sessionKey) return [];
    const runId = string(p.runId) ?? string(meta.runId);
    const out: GatewayLiveUpdate[] = [];
    // sessions.changed is sent even for headless runs whose chat stream is hidden.
    // Only explicit activeRunIds/hasActiveRun is authoritative, never lastRunId.
    if (event === 'sessions.changed') {
      if (Array.isArray(session.activeRunIds)) {
        for (const id of session.activeRunIds) if (typeof id === 'string' && id) this.ingest('chat', { sessionKey, runId: id, state: 'status' }, now);
      }
      if (session.hasActiveRun === false) {
        for (const run of this.runs.values()) if (run.sessionKey === sessionKey) run.closed = true;
      }
      if (!runId) return out;
    }
    const isTool = event === 'session.tool' || (event === 'agent' && p.stream === 'tool');
    const phase = string(data.phase) ?? string(p.phase);
    const lifecycle = (event === 'agent' && p.stream === 'lifecycle') || event === 'sessions.changed';
    const isUser = event === 'session.message' && message.role === 'user'
      && !!string(gatewayMessageText(message.content) || message.text);
    const messageId = string(p.messageId) ?? string(meta.id);
    if (isUser && messageId) {
      const id = `${sessionKey}|${messageId}`;
      if (this.messages.has(id)) return out;
      this.messages.set(id, true); this.bounded(this.messages, GATEWAY_LIVE_RULES.maxTools);
    }
    const terminal = (event === 'chat' && ['final','error','aborted'].includes(String(p.state)))
      || (lifecycle && GATEWAY_LIVE_RULES.terminalPhases.includes(phase as never));
    const toolBody = Object.keys(data).length ? data : p;
    const validTool = isTool && ['start', 'update', 'result'].includes(String(toolBody.phase)) && !!string(toolBody.toolCallId) && !!string(toolBody.name);
    const active = isUser || validTool || (event === 'chat' && ['status','delta'].includes(String(p.state)))
      || (event === 'agent' && p.stream === 'run_status')
      || (lifecycle && GATEWAY_LIVE_RULES.activePhases.includes(phase as never));
    const assistant = event === 'session.message' && message.role === 'assistant';
    if (!active && !terminal && !assistant) return out;
    const pendingKey = `session:${sessionKey}`;
    const key = runId ? `run:${runId}` : pendingKey;
    let run = this.runs.get(key);
    if (!run && !runId) run = [...this.runs.values()].reverse().find(r => r.sessionKey === sessionKey && !r.closed);
    if (!run && runId) {
      run = this.runs.get(pendingKey);
      if (run && !run.closed) {
        this.runs.delete(pendingKey); run.runId = runId; this.runs.set(key, run);
        if (run.prompt) out.push({ entry: this.row(run, 'chat_start', run.startedAt, run.prompt, run.prompt), upsert: true });
      } else run = undefined;
    }
    if (!run || (isUser && run.closed && !runId)) {
      // Historical assistant messages must not manufacture work.
      if (!active && !terminal) return out;
      run = { sessionKey, runId, startedAt: now, response: '', closed: false, responseEmitted: false,
        automated: sessionKey.includes(':cron:') || sessionKey.includes(':heartbeat') };
      this.runs.set(key, run); this.bounded(this.runs, GATEWAY_LIVE_RULES.maxRuns);
    }
    // Late/replayed lifecycle and tools cannot resurrect a completed run.
    if (run.closed && !terminal && !assistant && !(isTool && phase === 'result')) return out;
    if (isUser) {
      const text = gatewayMessageText(message.content) || string(message.text);
      if (text && !run.prompt) {
        run.prompt = text; run.automated ||= text.trimStart().startsWith('[cron:');
        out.push({ entry: this.row(run, 'chat_start', run.startedAt, run.automated && text.trimStart().startsWith('[cron:') ? 'Scheduled task' : text, text) });
      }
    }
    if (event === 'chat' && p.state === 'delta') run.response = gatewayMessageText(message.content) || run.response;
    if (assistant && message.stopReason !== 'toolUse') run.response = gatewayMessageText(message.content) || run.response;
    if (isTool) {
      const body = Object.keys(data).length ? data : p;
      const toolId = string(body.toolCallId) ?? string(p.toolCallId);
      const name = string(body.name) ?? string(p.name);
      if (toolId && name) {
        const toolKey = `${run.runId ?? sessionKey}|${toolId}`;
        const existing = this.tools.get(toolKey);
        const tool = existing ?? { name, input: body.args ?? body.input, ts: now, done: false };
        this.tools.set(toolKey, tool); this.bounded(this.tools, GATEWAY_LIVE_RULES.maxTools);
        if (tool.input == null) tool.input = body.args ?? body.input;
        if (body.phase === 'result' && !tool.done) {
          tool.done = true;
          const result = body.result ?? body.output ?? body.error;
          const failed = body.isError === true || body.error != null || gatewayObject(gatewayObject(result).details).status === 'failed';
          const action = gatewayObject(tool.input).action;
          // Process polling is progress bookkeeping. Errors remain visible.
          if (failed || tool.name !== 'process' || !GATEWAY_LIVE_RULES.quietProcessActions.includes(action as never)) {
            const command = string(gatewayObject(tool.input).command) ?? string(gatewayObject(tool.input).path) ?? string(action);
            const output = gatewayMessageText(gatewayObject(result).content) || (typeof result === 'string' ? result : '');
            const raw = `${tool.name}${command ? ` · ${command.replace(/\s+/g, ' ')}` : ''}${failed ? ' · failed' : ''}`;
            out.push({ entry: { ...this.row(run, 'tool_exec', now, raw, [`session: ${sessionKey}`, command, output].filter(Boolean).join('\n')), startedAt: tool.ts, endedAt: now } });
          }
        }
      }
    }
    if (terminal) {
      run.closed = true;
      const text = gatewayMessageText(message.content) || string(gatewayObject(data.terminalReply).text) || run.response;
      // Lifecycle end can precede chat.final. Keep the single full response.
      if (!run.responseEmitted && (text || event === 'chat')) {
        run.responseEmitted = true;
        const error = p.state === 'error' || p.state === 'aborted' || phase === 'error' || phase === 'aborted';
        const label = error
          ? string(p.errorMessage) || string(data.error) || `Chat ${p.state === 'aborted' || phase === 'aborted' ? 'aborted' : 'error'}${p.errorKind ? ` (${p.errorKind})` : ''}`
          : text || 'Completed';
        const detail = error ? [label, p.errorKind && `kind ${p.errorKind}`, p.stopReason && `stop ${p.stopReason}`, run.runId && `run ${run.runId}`, `session ${sessionKey}`, text].filter(Boolean).join(' · ') : text;
        out.push({ entry: { ...this.row(run, error ? 'error' : text ? 'chat_response' : 'chat_end', now, label, detail), endedAt: now, ...(!text && !error ? { summaryKind: 'none' as const } : {}) } });
      }
    }
    return out;
  }
}
