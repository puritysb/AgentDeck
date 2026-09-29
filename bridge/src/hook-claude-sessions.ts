/** Hook truth for existing ordinary Claude rows. Never synthesizes identities. */
import { stripUnsafeText } from '@agentdeck/shared';

const EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SessionEnd']);
const MAX_SESSIONS = 4096;
const MAX_TOOLS = 256;

interface Lifecycle {
  state: 'idle' | 'processing' | 'ended';
  tools: Map<string, string>;
}

export class HookClaudeSessions {
  private readonly sessions = new Map<string, Lifecycle>();

  /** Returns whether a fresh roster should be delivered. SessionEnd tombstones
   * survive trailing hooks; only SessionStart reopens them. Bounded by the
   * most recent 4096 session identities, without aging out long-running tools. */
  note(event: string, payload: Record<string, unknown>): boolean {
    if (!EVENTS.has(event)) return false;
    const sid = payload.session_id;
    if (typeof sid !== 'string' || !sid.trim() || sid.length > 256) return false;
    const prior = this.sessions.get(sid);
    if (prior?.state === 'ended' && event !== 'SessionStart') return false;
    // An orphan completion may establish processing after daemon restart, but
    // must not undo a Stop we actually observed.
    if (prior?.state === 'idle' && (event === 'PostToolUse' || event === 'PostToolUseFailure')) return false;
    const row: Lifecycle = prior ?? { state: 'processing', tools: new Map() };
    const toolId = typeof payload.tool_use_id === 'string' && payload.tool_use_id.length <= 256
      ? payload.tool_use_id : '';
    switch (event) {
      case 'SessionStart':
      case 'Stop':
      case 'SessionEnd':
      case 'UserPromptSubmit':
        row.tools.clear();
        row.state = event === 'SessionEnd' ? 'ended' : event === 'UserPromptSubmit' ? 'processing' : 'idle';
        break;
      case 'PreToolUse': {
        row.state = 'processing';
        // Publish only the tool name, never arguments, commands or responses.
        const name = typeof payload.tool_name === 'string'
          ? stripUnsafeText(payload.tool_name.slice(0, 512)).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 128)
          : '';
        row.tools.delete(toolId);
        row.tools.set(toolId, name || 'Tool');
        if (row.tools.size > MAX_TOOLS) row.tools.delete(row.tools.keys().next().value!);
        break;
      }
      default:
        row.state = 'processing';
        row.tools.delete(toolId);
    }
    this.sessions.delete(sid);
    this.sessions.set(sid, row);
    if (this.sessions.size > MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value!);
    return true;
  }

  /** Apply before the permission/option overlay, which retains precedence.
   * Observer-owned metadata and cached objects must remain untouched. */
  applyTo<T extends { id: string; state?: string; currentTool?: string }>(sessions: T[]): T[] {
    return sessions.flatMap((session) => {
      if (!session.id.startsWith('observed:claude:')) return [session];
      const row = this.sessions.get(session.id.slice('observed:claude:'.length));
      if (!row) return [session];
      if (row.state === 'ended') return [];
      const currentTool = [...row.tools.values()].at(-1);
      return [{ ...session, state: row.state, currentTool }];
    });
  }
}
