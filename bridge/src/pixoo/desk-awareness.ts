import type { SessionInfo, TimelineEntry } from '@agentdeck/shared';
import { UI } from '@agentdeck/shared';
import { drawText } from './pixoo-font.js';

export type DeskSignal = 'waiting' | 'error' | 'done' | 'working' | 'idle' | 'unknown';
export function deskSignal(sessions: SessionInfo[] | null, timeline: TimelineEntry[], now: number) {
  if (sessions === null) return { kind: 'unknown' as DeskSignal, count: 0 };
  const live = sessions.filter(s => s.alive);
  const waiting = live.filter(s => s.state?.startsWith('awaiting')).length;
  if (waiting) return { kind: 'waiting' as DeskSignal, count: waiting };
  const errors = live.filter(s => s.state === 'error').length;
  if (errors) return { kind: 'error' as DeskSignal, count: errors };
  // Only explicit response/task completion events earn a completion signal.
  // A disappearing or idle session, reconnect, or quota limit is not success.
  const done = timeline.filter(e => (e.type === 'chat_response' || e.type === 'task_end') &&
    e.status !== 'abandoned' && e.status !== 'denied' && e.status !== 'pending' && now >= e.ts && now - e.ts < 90_000).length;
  if (done) return { kind: 'done' as DeskSignal, count: done };
  const working = live.filter(s => s.state === 'processing').length;
  if (working) return { kind: 'working' as DeskSignal, count: working };
  return { kind: 'idle' as DeskSignal, count: live.length };
}

/** Native signal boards. No quota-derived alarms or continuous work animation. */
export function renderDeskAwareness(size: 11 | 32, sessions: SessionInfo[] | null,
  timeline: TimelineEntry[], now: number): Uint8Array {
  const { kind, count } = deskSignal(sessions, timeline, now);
  const hex = kind === 'waiting' ? UI.attn : kind === 'error' ? UI.error :
    kind === 'done' ? UI.ok : kind === 'working' ? UI.cyan : UI.idleDark;
  const color = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const out = new Uint8Array(size * size * 3);
  // Quiet states are intentionally dim. Only attention pulses.
  const intensity = kind === 'waiting' ? (Math.floor(now / 1500) % 2 ? .55 : 1) :
    kind === 'idle' || kind === 'unknown' ? .22 : kind === 'working' ? .45 : .8;
  const put = (x: number, y: number, value = 1) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    for (let c = 0; c < 3; c++) out[(y * size + x) * 3 + c] = Math.round(color[c] * intensity * value);
  };
  if (size === 32) {
    const labels = { waiting: 'WAIT', error: 'ERROR', done: 'RESULT', working: 'WORK', idle: 'IDLE', unknown: 'SYNC' };
    const text = (s: string, y: number, scale: number) => {
      const temp = new Uint8Array(64 * 64 * 3);
      drawText(temp, 0, 0, s, hex);
      const width = s.length * 4 - 1, left = Math.floor((32 - width * scale) / 2);
      for (let row = 0; row < 5; row++) for (let x = 0; x < width; x++) {
        if (!temp[(row * 64 + x) * 3] && !temp[(row * 64 + x) * 3 + 1]) continue;
        for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) put(left + x * scale + dx, y + row * scale + dy);
      }
    };
    text(labels[kind], 3, 1);
    text(kind === 'unknown' ? '-' : count > 99 ? '99+' : String(count), 13, 2);
    for (let x = 4; x < 28; x++) put(x, 28, .35);
  } else {
    const glyph = kind === 'waiting' ? ['00100','00100','00100','00000','00100'] :
      kind === 'error' ? ['10001','01010','00100','01010','10001'] :
      kind === 'done' ? ['00001','00010','10100','01000','00000'] :
      kind === 'working' ? ['00000','11011','11011','11011','00000'] :
      kind === 'unknown' ? ['11100','00100','01100','00000','01000'] :
      ['00000','00000','00100','00000','00000'];
    for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) if (glyph[y][x] === '1') put(x + 3, y + 3);
  }
  return out;
}
