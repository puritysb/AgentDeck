/**
 * AgentDeck Ulanzi Studio plugin — Node.js main service entry.
 *
 * ONE dynamic action ("AgentDeck"): the user fills the D200H keys with it.
 * Session-centric two-level UX (AgentDeck v4):
 *   • LIST  — one session per key (fixed position, awaiting emphasized).
 *   • DETAIL — press a session → keys reflow to its options / permission /
 *     quick-actions + BACK + STOP.
 * Ulanzi addresses keys as `col_row`; we lay out over whatever keys the user
 * placed the action on. The view (list/detail, focused session, page) is tracked
 * here; `buildSessionDeck` (shared) is the stateless layout engine.
 *
 *   daemon broadcasts → recompute deck → per-key PNG/GIF → Ulanzi
 *   key press → cell action → view change and/or daemon command
 */
import { buildSessionDeck, type DeckView, RECONNECT_BACKOFF_MS } from '@agentdeck/shared';
import { UlanziApiCtor, type UlanziApi, type UlanziMessage } from './ulanzi.js';
import { DaemonClient } from './daemon-client.js';
import { ReconnectSupervisor } from './reconnect-supervisor.js';
import { StateStore } from './state-store.js';
import { deckSignature } from './deck-signature.js';
import { svgToBase64Png, ICON_SIZE } from './raster.js';
import { framesToGifBase64 } from './gif.js';
import { launchCompanionApp } from './launch.js';
import { dinfo, dlog, derr, flog } from './log.js';

const PLUGIN_UUID = 'com.ulanzi.ulanzistudio.agentdeck';
const TAG = 'app';

const ANIM_FRAMES = 14;
const ANIM_STEP = 3;
const ANIM_DELAY_MS = 70;
// GIF animation is OFF by default: encoding it for every processing/awaiting
// session each render churns CPU and makes pushes heavy, which the slow D200H
// LCD can't keep up with (laggy, BACK feels unresponsive). Opt in explicitly.
const ANIMATE = process.env.AGENTDECK_ULANZI_ANIM === '1';

interface Instance {
  context: string;
  key: string; // col_row
  lastSig?: string;
}

const $UD: UlanziApi = new UlanziApiCtor();
const daemon = new DaemonClient();
const store = new StateStore();

const instances = new Map<string, Instance>();
let view: DeckView = { mode: 'list', page: 0 };

// Coalesce bursts of daemon broadcasts into at most one render per MIN_GAP.
// Pushing on every event floods Studio→hardware (the LCD can't keep up and
// drops frames, leaving the device stale while Studio's UI stays current).
const MIN_RENDER_GAP_MS = 120;
let renderTimer: ReturnType<typeof setTimeout> | null = null;
let lastRenderAt = 0;
function scheduleRender(): void {
  if (renderTimer) return;
  const wait = Math.max(0, MIN_RENDER_GAP_MS - (Date.now() - lastRenderAt));
  renderTimer = setTimeout(() => {
    renderTimer = null;
    lastRenderAt = Date.now();
    renderAll();
  }, wait);
}

function positions(): string[] {
  return [...instances.values()].map((i) => i.key);
}

// Paced per-key push to the device. Map keeps only the latest image per key.
interface QueueItem { dataUri: string; isGif: boolean; }
const pushQueue = new Map<string, QueueItem>();
const PUSH_PER_TICK = 6;
const PUSH_TICK_MS = 30;
let drainTimer: ReturnType<typeof setInterval> | null = null;
function ensureDrainer(): void {
  if (drainTimer) return;
  drainTimer = setInterval(() => {
    if (pushQueue.size === 0) { if (drainTimer) clearInterval(drainTimer); drainTimer = null; return; }
    let n = 0;
    for (const [ctx, item] of pushQueue) {
      pushQueue.delete(ctx);
      try {
        if (item.isGif) $UD.setGifDataIcon(ctx, item.dataUri);
        else $UD.setBaseDataIcon(ctx, item.dataUri);
      } catch (err) { derr(TAG, `push failed: ${err}`); }
      if (++n >= PUSH_PER_TICK) break;
    }
  }, PUSH_TICK_MS);
}

function layoutInput(): Record<string, unknown> {
  const selectedSessionId = view.mode === 'detail' ? view.openSessionId : undefined;
  return store.toLayoutInput(selectedSessionId);
}

function deckFor(animFrame: number, animated: boolean) {
  // showUsage pins the bottom-row keys left of the D200H clock widget to the
  // quota gauges — this surface has no encoder LCD to carry usage.
  return buildSessionDeck(
    layoutInput(),
    { ...view, animFrame, animated, showUsage: true, voiceState: store.voiceState },
    positions(),
  );
}

let lastDeckSig = '';
/** Question the open detail view was last rendered for — a change resets paging. */
let lastOpenQuestion = '';

// Host display asleep. The D200H has no brightness command exposed through the
// Studio SDK, so "dark" has to be pixels: push a black icon to every key and
// stop rendering until wake. Mirrors the Stream Deck plugin's dimAllActions().
const BLACK_KEY_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><rect width="144" height="144" fill="#000"/></svg>';
let displayDimmed = false;

function dimAllKeys(): void {
  const dataUri = `data:image/png;base64,${svgToBase64Png(BLACK_KEY_SVG)}`;
  for (const inst of instances.values()) {
    // Clear lastSig so the wake repaint is not swallowed by the per-key dedup.
    inst.lastSig = '';
    pushQueue.set(inst.context, { dataUri, isGif: false });
  }
  lastDeckSig = '';
  if (instances.size > 0) ensureDrainer();
}

function renderAll(): void {
  if (displayDimmed) return;
  const ev = layoutInput();
  // If the focused session vanished, drop back to the list.
  if (view.mode === 'detail' && view.openSessionId) {
    const sessions = (ev.allSessions as Array<{ id: string }>) ?? [];
    if (!sessions.some((s) => s.id === view.openSessionId)) view = { mode: 'list', page: 0 };
  }
  // A new question means a new option list, and page 2 of the old one is not
  // page 2 of the new one — carrying the page over shows the wrong options (or
  // an empty page). Only the question identity resets it; paging by hand stays.
  const openQuestion = view.mode === 'detail' ? ((ev.question as string) ?? '') : '';
  if (openQuestion !== lastOpenQuestion) {
    lastOpenQuestion = openQuestion;
    if (view.mode === 'detail' && (view.page ?? 0) !== 0) view = { ...view, page: 0 };
  }

  // Skip the rebuild+raster when neither the view nor the visible state changed.
  // voiceState is part of the signature: the VOICE tile is the only key that
  // changes on a voice_state event, and a sig that omits it swallows exactly
  // that repaint (the recurring deckSignature failure mode).
  const sig = `${view.mode}|${view.openSessionId ?? ''}|${view.page ?? 0}|${store.voiceState}|${deckSignature(ev)}`;
  if (sig === lastDeckSig) return;
  lastDeckSig = sig;
  lastRenderAt = Date.now();

  const staticDeck = deckFor(0, false);
  const probeDeck = ANIMATE ? deckFor(5, true) : null;
  let frameDecks: ReturnType<typeof deckFor>[] | null = null;
  const getFrameDecks = () =>
    (frameDecks ??= Array.from({ length: ANIM_FRAMES }, (_, i) => deckFor(i * ANIM_STEP, true)));

  // Enqueue changed keys; the drainer paces them to the device (a few per tick).
  // Blasting 12–13 keys at once on a view switch overruns the device — Studio's
  // UI updates but the hardware drops most, leaving stale keys.
  let changed = 0;
  for (const inst of instances.values()) {
    try {
      const cell = staticDeck.get(inst.key);
      const staticSvg = cell?.svg ?? '';
      const animates = ANIMATE && !!cell && probeDeck!.get(inst.key)?.svg !== staticSvg;
      const sig = `${animates ? 'A' : 'S'}|${staticSvg}`;
      if (sig === inst.lastSig) continue;
      inst.lastSig = sig;
      if (!cell) continue;
      let gif: string | null = null;
      if (animates) {
        const frames = getFrameDecks().map((d) => d.get(inst.key)?.svg ?? staticSvg);
        gif = framesToGifBase64({ frames, delayMs: ANIM_DELAY_MS }, ICON_SIZE);
      }
      // Full data URI — the device firmware needs the `data:` prefix to decode
      // (Studio's preview accepts bare base64, the hardware does not).
      pushQueue.set(inst.context, gif
        ? { dataUri: `data:image/gif;base64,${gif}`, isGif: true }
        : { dataUri: `data:image/png;base64,${svgToBase64Png(staticSvg)}`, isGif: false });
      changed++;
    } catch (err) {
      derr(TAG, `render ${inst.key} failed: ${err}`);
    }
  }
  if (changed > 0) { dlog(TAG, `queue ${changed} key(s) (view=${view.mode})`); ensureDrainer(); }
}

// ---- Ulanzi Studio side ----
// The vendored SDK never reconnects its Studio socket; a supervisor mirrors the
// daemon link's wake-watchdog + backoff so the device recovers after sleep/wake
// (USB detach drops the Studio socket and it would otherwise stay dead forever).
// On re-open, force a full re-render: the keys we already know about may not be
// re-announced via onAdd, so invalidate every cached signature and re-push.
function resyncStudioBridge(): void {
  lastDeckSig = '';
  for (const inst of instances.values()) inst.lastSig = undefined;
  scheduleRender();
}
const studioSupervisor = new ReconnectSupervisor({
  connect: () => $UD.connect(PLUGIN_UUID),
  backoffMs: RECONNECT_BACKOFF_MS,
  onReconnect: resyncStudioBridge,
  log: (m) => dlog(TAG, m),
});
// Register handlers BEFORE the first connect so the initial open isn't missed.
$UD.onConnected(() => { dinfo(TAG, 'Ulanzi Studio bridge connected'); studioSupervisor.noteOpen(); });
$UD.onClose(() => { dlog(TAG, 'Ulanzi Studio bridge closed'); studioSupervisor.noteClosed(); });
$UD.onError((e) => { derr(TAG, `Ulanzi bridge error: ${e}`); studioSupervisor.noteClosed(); });
studioSupervisor.start();

$UD.onAdd((m: UlanziMessage) => {
  flog('RAW', 'onAdd', m);
  instances.set(m.context, { context: m.context, key: m.key });
  dlog(TAG, `add key ${m.key}`);
  scheduleRender(); // coalesce the burst of per-key onAdd at startup
});

$UD.onClear((m: UlanziMessage) => {
  const param = m.param as unknown;
  const items = Array.isArray(param) ? (param as Array<{ context: string }>) : [];
  for (const it of items) instances.delete(it.context);
});

function onPress(m: UlanziMessage): void {
  flog('RAW', 'press', m);
  const inst = instances.get(m.context);
  if (!inst) { flog(TAG, `press: no instance for context ${m.context} (key=${m.key})`); $UD.emit('add', m); return; }
  const known = positions().sort();
  flog(TAG, `press key=${inst.key} view=${view.mode} positions=[${known.join(',')}]`);
  const action = deckFor(0, false).get(inst.key)?.action;
  if (!action) { dlog(TAG, `press ${inst.key} (inert)`); return; }
  switch (action.kind) {
    case 'open':
      store.prepareFocus(action.sessionId);
      view = { mode: 'detail', openSessionId: action.sessionId, page: 0 };
      daemon.send({ type: 'focus_session', sessionId: action.sessionId });
      renderAll();
      break;
    case 'back':
      view = { mode: 'list', page: 0 };
      renderAll();
      break;
    case 'page':
      view = { ...view, page: (view.page ?? 0) + action.delta };
      renderAll();
      break;
    case 'command':
      dlog(TAG, `press ${inst.key} → ${action.command.type}`);
      daemon.send(action.command);
      // REVIEW must acknowledge the press instantly: flip the tile to
      // REVIEWING locally before the daemon's review_status/sessions_list
      // round trip (which can lag many seconds while a judge is busy).
      if (action.command.type === 'review_run') {
        const sid = (action.command as { sessionId?: string }).sessionId;
        if (sid) { store.markReviewPending(sid); renderAll(); }
      }
      break;
    case 'launch':
      // Daemon down → there's no WS to send to; open the companion app instead.
      dlog(TAG, `press ${inst.key} → launch companion app`);
      void launchCompanionApp().catch((e) => derr(TAG, `launch failed: ${e}`));
      break;
  }
}
// IMPORTANT: the device fires BOTH `keydown` AND `run` for one physical press
// (~300ms apart). Handle ONLY `run` (the SDK's documented main trigger) so a
// single press is a single action — wiring both double-fires and cancels out
// (open→back). keydown/keyUp are diagnostic-only.
$UD.onRun(onPress);
$UD.onKeyDown((m: UlanziMessage) => flog('RAW', 'keydown(ignored)', m.key));
$UD.onKeyUp((m: UlanziMessage) => flog('RAW', 'keyUp(ignored)', m.key));

// ---- AgentDeck daemon side ----
let voiceErrorResetTimer: ReturnType<typeof setTimeout> | null = null;
daemon.on('event', (ev) => {
  // The daemon parks on 'error' after a failed capture; without a local
  // reset the VOICE tile would read "no speech" until the next dictation.
  if ((ev as { type?: string }).type === 'voice_state') {
    if (voiceErrorResetTimer) { clearTimeout(voiceErrorResetTimer); voiceErrorResetTimer = null; }
    if ((ev as { state?: string }).state === 'error') {
      voiceErrorResetTimer = setTimeout(() => {
        voiceErrorResetTimer = null;
        store.voiceState = 'idle';
        scheduleRender();
      }, 3000);
    }
  }
  if ((ev as { type?: string }).type === 'display_state') {
    const e = ev as { displayOn?: boolean; dim?: { enabled?: boolean } };
    // `dim.enabled === false` means the user asked us to leave hardware lit.
    const shouldDim = e.displayOn === false && e.dim?.enabled !== false;
    if (shouldDim && !displayDimmed) {
      displayDimmed = true;
      dimAllKeys();
    } else if (!shouldDim && displayDimmed) {
      displayDimmed = false;
      scheduleRender();
    }
    return;
  }
  if (store.apply(ev)) scheduleRender();
});
daemon.on('connected', () => {
  dinfo(TAG, 'daemon connected');
  store.setConnected(true);
  // Pull fresh quota immediately so the pinned 5H/7D gauges aren't blank until
  // the next session IDLE transition triggers a usage fetch on the daemon.
  daemon.send({ type: 'query_usage' });
  scheduleRender();
});
daemon.on('disconnected', () => { dlog(TAG, 'daemon disconnected'); store.setConnected(false); view = { mode: 'list', page: 0 }; scheduleRender(); });
daemon.start();

dinfo(TAG, 'AgentDeck Ulanzi plugin started');
