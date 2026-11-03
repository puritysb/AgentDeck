import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { normalizeSessionDisplayName } from '@agentdeck/shared';
import { readCmuxSurface, type CmuxSurface } from './observed-inject.js';

type Row = { id: string; pid: number; startedAt?: string; tty?: string; displayName?: string };
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const rows = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;

/** macOS cmux 0.65.1 system.tree; no selected/focused workspace inference.
 * A surface move is resolved from the current single snapshot, never its
 * inherited CMUX_WORKSPACE_ID. Unknown/ambiguous data supplies no title. */
export function cmuxTitles(result: unknown): Map<string, string> {
  const names = new Map<string, string>();
  const seen = new Set<string>();
  let count = 0;
  for (const window of rows(object(result)?.windows)) {
    for (const workspace of rows(object(window)?.workspaces)) {
      const w = object(workspace);
      for (const pane of rows(w?.panes)) {
        for (const surface of rows(object(pane)?.surfaces)) {
          if (++count > 4096) return new Map();
          const s = object(surface);
          if (typeof s?.id !== 'string' || !uuid.test(s.id)) continue;
          const id = s.id.toLowerCase();
          if (seen.has(id)) { names.delete(id); continue; }
          seen.add(id);
          if (s.type !== 'terminal') continue;
          const ws = typeof w?.title === 'string' ? normalizeSessionDisplayName(w.title) : '';
          const title = typeof s.title === 'string' ? normalizeSessionDisplayName(s.title) : '';
          names.set(id, normalizeSessionDisplayName(ws && title && ws !== title ? `${ws} / ${title}` : title || ws));
        }
      }
    }
  }
  return names;
}

/** Read-only IPC, one line and bounded bytes/time. Access refusal is a missing
 * hint; it never changes cmux settings, prompts for Automation or sends input. */
export function readCmuxTitles(path: string): Promise<Map<string, string>> {
  return new Promise(resolve => {
    const id = randomUUID(), socket = createConnection({ path });
    let data = Buffer.alloc(0), settled = false;
    const finish = (value = new Map<string, string>()) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy(); resolve(value);
    };
    const timer = setTimeout(() => finish(), 500);
    socket.on('error', () => finish());
    socket.on('end', () => finish());
    socket.on('connect', () => socket.write(JSON.stringify({id,method:'system.tree',params:{}}) + '\n'));
    socket.on('data', chunk => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      if (data.length + bytes.length > 512 * 1024) { finish(); return; }
      data = Buffer.concat([data, bytes]);
      const end = data.indexOf(10);
      if (end < 0) return;
      try {
        const response = JSON.parse(data.subarray(0, end).toString('utf8'));
        finish(response.id === id && response.ok === true ? cmuxTitles(response.result) : undefined);
      } catch { finish(); }
    });
  });
}

export class CmuxDisplayNames {
  private identities = new Map<string, { at: number; surface?: CmuxSurface }>();
  constructor(
    private readonly inspect = (pid: number) => readCmuxSurface(pid, 150),
    private readonly read = readCmuxTitles,
  ) {}
  async refresh<T extends Row>(sessions: T[], now = Date.now()): Promise<void> {
    const active = new Set(sessions.map(row => `${row.pid}:${row.id}:${row.startedAt}`));
    for (const key of this.identities.keys()) if (!active.has(key)) this.identities.delete(key);
    const pending = sessions.filter(row => row.tty && row.pid > 1).map(row => ({row,key:`${row.pid}:${row.id}:${row.startedAt}`}));
    const deadline = Date.now() + 1500;
    await Promise.all(Array.from({length: 4}, async () => {
      while (pending.length && Date.now() < deadline) {
        const item = pending.shift()!;
        const cached = this.identities.get(item.key);
        if (!cached || now - cached.at >= 30_000) this.identities.set(item.key, {at:now,surface:await this.inspect(item.row.pid)});
      }
    }));
    const sockets = new Map<string, Promise<Map<string, string>>>();
    for (const row of sessions) {
      const surface = this.identities.get(`${row.pid}:${row.id}:${row.startedAt}`)?.surface;
      if (!surface) continue;
      const path = surface.socketPath ?? '/tmp/cmux.sock';
      if (!sockets.has(path) && sockets.size < 4) sockets.set(path, this.read(path).catch(() => new Map()));
    }
    await Promise.all([...sockets.values()]);
    for (const row of sessions) {
      const surface = this.identities.get(`${row.pid}:${row.id}:${row.startedAt}`)?.surface;
      if (!surface) continue;
      const title = (await sockets.get(surface.socketPath ?? '/tmp/cmux.sock'))?.get(surface.surfaceId.toLowerCase());
      if (title) row.displayName = title;
    }
  }
}
