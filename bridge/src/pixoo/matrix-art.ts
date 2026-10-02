/** Canonical pixel art for both BLE runtimes. Swift consumes generated RLE frames
 * from this renderer, so eyes, official masks and motion cannot drift by platform. */
import { Brand, UI, MATRIX_RULES, MATRIX_POLICY, type MatrixKind, type MatrixScene } from '@agentdeck/shared';
import { OFFICIAL_DOT_GLYPHS, type OfficialDotGlyphName } from './official-dot-glyphs.generated.js';
import { drawText } from './pixoo-font.js';

export const MATRIX_COLORS: Record<MatrixKind, string> = {
  waiting: UI.attn, error: UI.error, done: UI.ok, working: UI.cyan,
  idle: UI.idle, unknown: UI.idleDark, arrival: UI.cyan,
  // A conversation in flight is activity (cyan); an answer landed is health (green).
  asked: UI.cyan, reply: UI.ok,
};
export const MATRIX_LAYOUT = { countX: 20, countColumns: 3, countY: 1, dotX: 1, dotY: 29, dotStep: 4, summaryStep: 8, zeroRowIntensity: .35, zeroCountIntensity: .4, dotIntensity: .7, digitStep: 4, maxCount: 99 };
export const MATRIX_GLYPHS = ['summary', 'summary-error', 'neutral', ...Object.keys(OFFICIAL_DOT_GLYPHS)];
export function rgb(hex: string): number[] { return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)); }
function painter(buf: Uint8Array, size: number) {
  return (x: number, y: number, color: string, brightness = 1) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    rgb(color).forEach((v, c) => { buf[(y * size + x) * 3 + c] = Math.round(v * brightness); });
  };
}
export function matrixDigit(value: string): number[] {
  const temp = new Uint8Array(64 * 64 * 3);
  drawText(temp, 0, 0, value, UI.hudText);
  return Array.from({ length: 15 }, (_, i) => temp[(Math.floor(i / 3) * 64 + i % 3) * 3] ? 1 : 0);
}
export function renderMatrixBase(size: 11 | 32, kind: MatrixKind, glyph: string, frame: number): Uint8Array {
  const out = new Uint8Array(size * size * 3);
  const put = painter(out, size), color = MATRIX_COLORS[kind];
  if (size === 11) {
    // A single robot face, not a miniature logo. Broad shapes survive 4-bit BLE.
    const rect = (x: number, y: number, w: number, h: number, dim = 1) => {
      for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) put(xx, yy, color, dim);
    };
    const blink = frame >= 6;
    if (kind === 'unknown') {
      // Closed, broken eyes: distinct from neutral idle and a live worried face.
      rect(1, 5, 3, 1, .35); rect(7, 5, 3, 1, .35); put(5, 8, color, .5);
    } else if (kind === 'error') {
      for (const x of [1, 7]) { put(x, 3, color); put(x + 1, 4, color); put(x + 2, 3, color); rect(x, 5, 3, 1); }
      put(4, 8, color); put(5, 7, color); put(6, 8, color);
    } else if (kind === 'done') {
      // Happy crescent eyes and a smile; occasional delighted wink.
      for (const x of [1, 7]) {
        if (blink && x === 7) rect(x, 4, 3, 1);
        else { put(x, 4, color); put(x + 1, 3, color); put(x + 2, 4, color); }
      }
      put(3, 7, color); rect(4, 8, 3, 1); put(7, 7, color);
    } else if (kind === 'waiting') {
      // Raised brows, wide eyes, asking mouth. Amber alone modulates brightness.
      const dim = frame % 2 ? .65 : 1;
      rect(1, 1, 3, 1, dim); rect(7, 1, 3, 1, dim);
      for (const x of [1, 7]) {
        rect(x, blink ? 5 : 3, 3, blink ? 1 : 3, dim);
        if (!blink) put(x + 1, 4, UI.ttyBg);
      }
      put(4, 8, color, dim); put(5, 7, color, dim); put(6, 8, color, dim);
    } else if (kind === 'arrival') {
      for (const x of [1, 7]) rect(x, frame < 2 ? 4 : 3, 3, frame < 2 ? 1 : 3);
      put(4, 7, color); put(6, 7, color); rect(4, 8, 3, 1);
    } else if (kind === 'asked') {
      // Listening: open eyes turned toward the speaker, a small attentive mouth.
      for (const x of [1, 7]) {
        rect(x, blink ? 5 : 3, 3, blink ? 1 : 3, .9);
        if (!blink) rect(x, 4, 1, 2, .12);
      }
      put(5, 8, color);
    } else if (kind === 'reply') {
      // Talking: warm eyes, a mouth that opens and closes as it speaks.
      for (const x of [1, 7]) { put(x, 4, color); put(x + 1, 3, color); put(x + 2, 4, color); }
      if (frame % 2) rect(4, 7, 3, 2); else rect(4, 8, 3, 1);
    } else {
      const dim = kind === 'idle' ? .55 : .85;
      const gaze = kind === 'working' ? (frame < 3 ? 0 : 1) : 0;
      for (const x of [1, 7]) {
        rect(x, blink ? 5 : 3, 3, blink ? 1 : 3, dim);
        if (!blink) rect(x + gaze, 4, 1, 2, .12);
      }
      if (kind === 'working') { rect(4, 8, 2, 1, dim); put(6, frame % 4 < 2 ? 8 : 7, color, dim); }
      else rect(4, 8, 3, 1, dim);
    }
    return out;
  }

  if (glyph.startsWith('summary')) {
    const labels = ['WAIT', 'WORK', 'RSLT', glyph === 'summary-error' ? 'ERR' : 'LIVE'];
    const tones: MatrixKind[] = ['waiting', 'working', 'done', glyph === 'summary-error' ? 'error' : 'idle'];
    if (kind === 'unknown') {
      labels.splice(0, labels.length, 'SYNC');
      tones.splice(0, tones.length, 'unknown');
    }
    labels.forEach((label, row) => {
      const temp = new Uint8Array(64 * 64 * 3);
      drawText(temp, 0, 0, label, MATRIX_COLORS[tones[row]]);
      for (let y = 0; y < 5; y++) for (let x = 0; x < label.length * 4; x++) {
        if (temp[(y * 64 + x) * 3]) put(x + 2, y + 1 + row * MATRIX_LAYOUT.summaryStep,
          MATRIX_COLORS[tones[row]], tones[row] === 'waiting' && kind === 'waiting' && frame % 2 ? .65 : .8);
      }
    });
    return out;
  }
  // Event-only scene. A real entrance/response earns a short creature appearance;
  // there is no timer-driven species carousel hiding the information dashboard.
  for (let y = 7; y < 27; y++) for (let x = 0; x < 32; x++) put(x, y, UI.waterDeep, .3);
  const label = { waiting: 'WAIT', error: 'ERR', done: 'DONE', working: 'WORK', idle: 'IDLE', unknown: 'SYNC', arrival: 'NEW', asked: 'ASK', reply: 'SENT' }[kind];
  const text = new Uint8Array(64 * 64 * 3);
  drawText(text, 0, 0, label, color);
  for (let y = 0; y < 5; y++) for (let x = 0; x < label.length * 4; x++) {
    if (text[(y * 64 + x) * 3]) put(x + 2, y + 1, color, kind === 'waiting' && frame % 2 ? .65 : 1);
  }
  if (kind === 'unknown') {
    // Sparse searching constellation; no creature is invented without a roster.
    for (const [x, y] of [[12, 15], [19, 15], [14, 20], [17, 20]]) put(x, y, color, .5);
    return out;
  }
  const bob = kind === 'working' || kind === 'asked' ? [0, 0, -1, -1, 0, 0, 1, 1][frame] : 0;
  const rise = kind === 'arrival' ? [8, 5, 2, 0, -1, 0, 0, 0][frame] : 0;
  const x0 = 7, y0 = 8 + bob + rise, side = 18;
  const mask = OFFICIAL_DOT_GLYPHS[glyph as OfficialDotGlyphName];
  if (mask) {
    const brand: Record<string, string> = { claudeCode: Brand.claudeCode, codex: Brand.codex,
      openCode: Brand.opencodeOnDark, openClaw: Brand.openclaw, antigravity: Brand.antigravity, kiro: Brand.kiro, zai: Brand.zai };
    for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
      const a = mask[Math.floor(y * 24 / side) * 24 + Math.floor(x * 24 / side)];
      if (a < 40 || y0 + y >= 27) continue;
      put(x0 + x, y0 + y, brand[glyph], Math.min(1, a / 255 * 1.15));
    }
  } else {
    // Neutral resident for future/unknown agents, never somebody else's logo.
    for (let y = 12; y <= 21; y++) for (let x = 10; x <= 21; x++) {
      if (y === 12 || y === 21 || x === 10 || x === 21) put(x, y + bob, UI.hudSubtext, .7);
    }
    for (const x of [13, 18]) put(x, 16 + bob, color);
    for (let x = 14; x <= 17; x++) put(x, 19 + bob, color);
  }
  if (kind === 'working') {
    // Orbiting tool/activity sparks (no fabricated progress percentage).
    const orbit = [[5, 12], [5, 17], [5, 23], [14, 26], [26, 23], [26, 17], [26, 12], [17, 8]];
    for (const offset of [0, 4]) { const [x, y] = orbit[(frame + offset) % 8]; put(x, y, color); }
  } else if (kind === 'asked') {
    // The reader's message travels in from the left edge to the agent.
    for (const offset of [0, 4]) {
      const x = (frame + offset) % 8 - 1;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) put(x + dx, 16 + dy, color, offset ? .55 : 1);
    }
  } else if (kind === 'reply') {
    // A speech bubble fills out beside the agent: the answer is the event.
    for (let y = 10; y <= 16; y++) for (let x = 25; x <= 31; x++) {
      if (y === 10 || y === 16 || x === 25 || x === 31) put(x, y, color, .8);
    }
    put(25, 17, color, .8); put(24, 18, color, .8);
    for (let d = 0; d < Math.min(3, (frame % 4) + 1); d++) put(26 + d * 2, 13, color);
  } else if (kind === 'arrival') {
    const spread = [2, 4, 7, 10, 12, 13, 14, 14][frame];
    for (const x of [16 - spread, 16 + spread]) for (const y of [10, 17, 24]) put(x, y, color, .8);
  } else if (kind === 'done') {
    const y = 24 - frame * 2;
    for (const x of [3, 28]) { put(x, y, color, .8); put(x, y + 1, color, .3); }
  } else if (kind === 'waiting' || kind === 'error') {
    for (const x of [3, 28]) for (let y = 12; y < 23; y++) {
      if (kind === 'error' || y % 3 !== 0) put(x, y, color, kind === 'waiting' && frame % 2 ? .65 : 1);
    }
  } else {
    // Idle water drifts slowly; the creature's identity stays intact.
    for (let x = 2; x < 30; x++) if ((x + Math.floor(frame / 2)) % 6 === 0) put(x, 26, color, .25);
  }
  return out;
}

export function renderMatrixScene(size: 11 | 32, scene: MatrixScene): Uint8Array {
  const out = renderMatrixBase(size, scene.kind, scene.glyph, scene.frame);
  if (size === 11) return out;
  const put = painter(out, 32);
  const number = (value: number, y: number, tone: MatrixKind) => {
    const count = scene.kind === 'unknown' ? '-' : value > MATRIX_LAYOUT.maxCount ? '99+' : String(value);
    for (let d = 0; d < count.length; d++) {
      matrixDigit(count[d]).forEach((v, i) => { if (v) put(MATRIX_LAYOUT.countX + (MATRIX_LAYOUT.countColumns - count.length + d) * MATRIX_LAYOUT.digitStep + i % 3,
        y + Math.floor(i / 3), MATRIX_COLORS[tone], value === 0 ? MATRIX_LAYOUT.zeroCountIntensity : 1); });
    }
  };
  if (scene.glyph.startsWith('summary')) {
    const error = scene.roster.includes('error');
    const tones: MatrixKind[] = [...MATRIX_POLICY.summaryKinds];
    if (error) tones[3] = 'error';
    // Error row is present even when waiting has higher priority.
    const base = renderMatrixBase(32, scene.kind, error ? 'summary-error' : 'summary', scene.frame);
    out.set(base);
    if (scene.kind !== 'unknown') scene.counts.forEach((value, row) => {
      if (value !== 0) return;
      for (let y = row * MATRIX_LAYOUT.summaryStep; y < (row + 1) * MATRIX_LAYOUT.summaryStep; y++) {
        for (let x = 0; x < 32 * 3; x++) out[y * 32 * 3 + x] = Math.round(out[y * 32 * 3 + x] * MATRIX_LAYOUT.zeroRowIntensity);
      }
    });
    if (scene.kind === 'unknown') number(0, MATRIX_LAYOUT.countY, 'unknown');
    else scene.counts.forEach((value, row) => number(value, MATRIX_LAYOUT.countY + row * MATRIX_LAYOUT.summaryStep, tones[row]));
    return out;
  }
  // A conversation scene's label carries the meaning; a count there would read
  // as a count of the conversation.
  if (scene.kind !== 'asked' && scene.kind !== 'reply') number(scene.count, MATRIX_LAYOUT.countY, scene.kind);
  scene.roster.slice(0, MATRIX_RULES.rosterDots).forEach((kind, i) => {
    const x = MATRIX_LAYOUT.dotX + i * MATRIX_LAYOUT.dotStep;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) put(x + dx, MATRIX_LAYOUT.dotY + dy, MATRIX_COLORS[kind], MATRIX_LAYOUT.dotIntensity);
    if (i === MATRIX_RULES.rosterDots - 1 && scene.roster.length > MATRIX_RULES.rosterDots) put(x, MATRIX_LAYOUT.dotY - 1, UI.hudText);
  });
  return out;
}
