import { basename } from 'node:path';
import type { EnrichedSession } from './session-aggregator.js';

const IDLE_TTL_MS = 30 * 60 * 1000;
const PROCESSING_TTL_MS = 3 * 60 * 1000;

interface HermesSession {
  id: string;
  projectName: string;
  modelName?: string;
  state: 'idle' | 'processing';
  startedAt: string;
  updatedAt: number;
  currentTool?: string;
  currentTask?: string;
  goal?: string;
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function extra(data: Record<string, unknown>): Record<string, unknown> {
  const value = data.extra;
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function nestedField(data: Record<string, unknown>, key: string): string | undefined {
  return stringField(data, key) ?? stringField(extra(data), key);
}

function projectFrom(data: Record<string, unknown>): string {
  const cwd = nestedField(data, 'cwd');
  if (cwd) return basename(cwd) || 'Hermes';
  const platform = nestedField(data, 'platform');
  return platform ? `Hermes · ${platform}` : 'Hermes';
}

/** Event-backed, read-only roster for Hermes gateway and CLI sessions. */
export class HermesSessionObserver {
  private readonly sessions = new Map<string, HermesSession>();

  constructor(private readonly onChanged?: () => void) {}

  ingest(boundary: string, data: Record<string, unknown>, now = Date.now()): void {
    const id = nestedField(data, 'session_id');
    if (!id) return;
    if (boundary === 'session_end') {
      if (this.sessions.delete(id)) this.onChanged?.();
      return;
    }

    const prior = this.sessions.get(id);
    const prompt = nestedField(data, 'prompt') ?? nestedField(data, 'user_message');
    const tool = nestedField(data, 'tool_name') ?? nestedField(data, 'tool');
    const session: HermesSession = {
      id,
      projectName: prior?.projectName ?? projectFrom(data),
      modelName: nestedField(data, 'model') ?? prior?.modelName,
      state: boundary === 'user_prompt_submit' || boundary === 'tool_start' || boundary === 'tool_end'
        ? 'processing' : 'idle',
      startedAt: prior?.startedAt ?? new Date(now).toISOString(),
      updatedAt: now,
      currentTool:
        boundary === 'tool_start'
          ? tool
          : boundary === 'tool_end' || boundary === 'stop'
            ? undefined
            : prior?.currentTool,
      currentTask: prompt ?? prior?.currentTask,
      goal: prior?.goal ?? prompt,
    };
    this.sessions.set(id, session);
    this.onChanged?.();
  }

  collect(now = Date.now()): EnrichedSession[] {
    for (const [id, session] of this.sessions) {
      const ttl = session.state === 'processing' ? PROCESSING_TTL_MS : IDLE_TTL_MS;
      if (now - session.updatedAt > ttl) this.sessions.delete(id);
    }
    return [...this.sessions.values()].map((session) => ({
      id: `observed:hermes:${session.id}`,
      port: 0,
      projectName: session.projectName,
      agentType: 'hermes',
      alive: true,
      state: session.state,
      modelName: session.modelName,
      startedAt: session.startedAt,
      controlMode: 'observed',
      currentTool: session.currentTool,
      currentTask: session.currentTask,
      goal: session.goal,
      activity: session.currentTool ?? session.currentTask,
    }));
  }
}
