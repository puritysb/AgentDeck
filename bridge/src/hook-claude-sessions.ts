/** Hook truth for existing ordinary Claude rows. Never synthesizes identities. */
import { stripUnsafeText } from '@agentdeck/shared';

const EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SessionEnd']);
const MAX_SESSIONS = 4096;
const MAX_TOOLS = 256;

interface Lifecycle {
  state: 'idle' | 'processing' | 'ended';
  tools: Map<string, string>;
  /** Claude's own words, verbatim: `SessionStart.model`, `effort.level`
   *  (carried by Stop, and it follows a live `/effort`), `permission_mode`
   *  (every event). Never defaulted — absent means the agent has not said. */
  model?: string;
  effortLevel?: string;
  permissionMode?: string;
}

/** A short printable token from a hook field, or undefined. */
function hookToken(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = stripUnsafeText(value.slice(0, 256)).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return clean ? clean.slice(0, 64) : undefined;
}

/** Model / effort / permission mode as Claude Code reports them in a hook
 *  payload (measured on 2.1.289). Exported for the Swift-parity tests. */
export function claudeHookSettings(payload: Record<string, unknown>): {
  model?: string; effortLevel?: string; permissionMode?: string;
} {
  const effort = payload.effort;
  return {
    model: hookToken(payload.model),
    effortLevel: effort && typeof effort === 'object' ? hookToken((effort as Record<string, unknown>).level) : undefined,
    permissionMode: hookToken(payload.permission_mode),
  };
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
    const settings = claudeHookSettings(payload);
    // A new session (SessionStart) starts from what it reports, not from the
    // identity's previous life.
    if (event === 'SessionStart') {
      row.model = undefined;
      row.effortLevel = undefined;
      row.permissionMode = undefined;
    }
    row.model = settings.model ?? row.model;
    row.effortLevel = settings.effortLevel ?? row.effortLevel;
    row.permissionMode = settings.permissionMode ?? row.permissionMode;
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
  applyTo<T extends {
    id: string; state?: string; currentTool?: string;
    modelName?: string; effortLevel?: string; permissionMode?: string;
  }>(sessions: T[]): T[] {
    return sessions.flatMap((session) => {
      if (!session.id.startsWith('observed:claude:')) return [session];
      const row = this.sessions.get(session.id.slice('observed:claude:'.length));
      if (!row) return [session];
      if (row.state === 'ended') return [];
      const currentTool = [...row.tools.values()].at(-1);
      return [{
        ...session,
        state: row.state,
        currentTool,
        // The transcript's `message.model` is the model that actually answered
        // (it follows a live `/model`); SessionStart's is only the opening one.
        ...(session.modelName ?? row.model ? { modelName: session.modelName ?? row.model } : {}),
        ...(row.effortLevel ? { effortLevel: row.effortLevel } : {}),
        ...(row.permissionMode ? { permissionMode: row.permissionMode } : {}),
      }];
    });
  }
}
