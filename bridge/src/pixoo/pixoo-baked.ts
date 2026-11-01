import { Script, createContext, type Context } from 'node:vm';
import type { SessionInfo, SubagentActivityBySession, TimelineEntry } from '@agentdeck/shared';
import type { StateUpdateEvent, UsageEvent } from '../types.js';
import { PIXOO_BAKED_SOURCE } from './pixoo-baked-source.generated.js';
import { PIXOO_LOOP_POLICY as P } from './pixoo-loop-policy.generated.js';

const script = new Script(PIXOO_BAKED_SOURCE);
export interface PixooBakeInput {
  nowMs: number; loop?: boolean; state: StateUpdateEvent | null; usage: UsageEvent | null;
  sessions: SessionInfo[] | null; subagents?: SubagentActivityBySession; timeline?: TimelineEntry[]; dimmed?: boolean;
}

/** One bounded raw loop, shared across devices, isolated from preview simulation.
 * Consumers get copies because their optional overlay mutates pixel buffers. */
export class PixooBakedRenderer {
  private context?: Context;
  private cached?: { key: string; frames: Uint8Array[] };
  clear(): void { this.cached = undefined; this.context = undefined; }
  private prepared(json: string): Context {
    if (!this.context) { this.context = createContext({}); script.runInContext(this.context, { timeout: 2000 }); }
    this.context.inputJSON = json;
    return this.context;
  }
  signature(input: PixooBakeInput): string | null {
    try {
      const json = JSON.stringify(input);
      if (!Number.isFinite(input.nowMs) || Buffer.byteLength(json) > P.maxInputBytes || (input.sessions?.length ?? 0) > P.maxSessions) return null;
      return new Script('agentdeckPixooSignature(inputJSON)').runInContext(this.prepared(json), { timeout: 2000 });
    } catch { return null; }
  }
  render(input: PixooBakeInput): Uint8Array[] {
    if (!Number.isFinite(input.nowMs) || (input.sessions?.length ?? 0) > P.maxSessions) throw new Error('pixoo_bake_limit');
    const json = JSON.stringify(input);
    if (Buffer.byteLength(json) > P.maxInputBytes) throw new Error('pixoo_bake_limit');
    const key = JSON.stringify({ ...input, nowMs: Math.floor(input.nowMs / P.loopRefreshMs) });
    if (this.cached?.key !== key) {
      const context = this.prepared(json);
      const result = new Script('agentdeckPixooBake(inputJSON)').runInContext(context, { timeout: 2000 });
      const frames = (JSON.parse(result) as string[]).map(s => Uint8Array.from(Buffer.from(s, 'base64')));
      if (frames.length !== (input.loop === false ? 1 : P.uniqueFrames * 2 - 2) || frames.some(f => f.length !== P.frameBytes)) throw new Error('pixoo_bake_invalid');
      this.cached = { key, frames };
    }
    return this.cached.frames.map(frame => frame.slice());
  }
}
