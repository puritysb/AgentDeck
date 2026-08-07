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
import {
  buildSessionDeck, type DeckView, RECONNECT_BACKOFF_MS,
  VoicePttHold, voiceCommandForAction,
} from '@agentdeck/shared';
import {
  ANIM_FRAMES,
  ANIM_DELAY_MS,
  ANIM_PROBE_FRAME,
  animFrameAt,
  frameOrderFor,
} from './anim-schedule.js';
import { UlanziApiCtor, type UlanziApi, type UlanziMessage } from './ulanzi.js';
import { DaemonClient } from './daemon-client.js';
import { ReconnectSupervisor } from './reconnect-supervisor.js';
import { StateStore } from './state-store.js';
import { deckSignature } from './deck-signature.js';
import { svgToBase64Png, GIF_ICON_SIZE } from './raster.js';
import { framesToGifBase64 } from './gif.js';
import { launchCompanionApp } from './launch.js';
import { dinfo, dlog, derr, flog } from './log.js';

const PLUGIN_UUID = 'com.ulanzi.ulanzistudio.agentdeck';
const TAG = 'app';

// GIF animation is ON: encodes are cached per tile appearance, run off the hot
// path a frame at a time, and ship as delta frames, so the churn that forced this
// off originally (re-encoding every render, synchronously, at full frame size) is
// gone. `AGENTDECK_ULANZI_ANIM=0` falls back to static PNG tiles.
const ANIMATE = process.env.AGENTDECK_ULANZI_ANIM !== '0';
// Encoded GIFs keyed by the tile's own SVG — a session returning to a state it
// already showed re-pushes instantly instead of re-encoding.
const GIF_CACHE_MAX = 64;
const gifCache = new Map<string, string>();
function cacheGif(key: string, gif: string): void {
  if (gifCache.size >= GIF_CACHE_MAX) {
    const oldest = gifCache.keys().next().value;
    if (oldest !== undefined) gifCache.delete(oldest);
  }
  gifCache.set(key, gif);
}

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
  // Drop queued loops — a GIF landing after the dim would relight the key. Wake
  // clears every cached signature, so they all re-queue then.
  animPending.clear();
  const dataUri = `data:image/png;base64,${svgToBase64Png(BLACK_KEY_SVG)}`;
  for (const inst of instances.values()) {
    // Clear lastSig so the wake repaint is not swallowed by the per-key dedup.
    inst.lastSig = '';
    pushQueue.set(inst.context, { dataUri, isGif: false });
  }
  lastDeckSig = '';
  if (instances.size > 0) ensureDrainer();
}

// ---- Background GIF encoding ----
// Encoding runs on the same thread that services Ulanzi Studio's socket, so it
// must never sit in the render path: a synchronous multi-frame encode is what made
// BACK feel unresponsive. Instead a changed key ships its static PNG immediately
// and joins this queue, which encodes one tile at a time and upgrades the key when
// the GIF is ready.
const animPending = new Set<string>(); // contexts awaiting a GIF
let animDraining = false;
// Bumped on every state change; the frame decks memo keys off it, so the 24 decks
// are rebuilt at most once per change no matter how many keys ask for them.
let deckVersion = 0;
let frameDeckMemo: { version: number; decks: ReturnType<typeof deckFor>[] } | null = null;

function frameDecks(): ReturnType<typeof deckFor>[] {
  if (frameDeckMemo?.version !== deckVersion) {
    frameDeckMemo = {
      version: deckVersion,
      decks: Array.from({ length: ANIM_FRAMES }, (_, i) => deckFor(animFrameAt(i), true)),
    };
  }
  return frameDeckMemo.decks;
}

async function drainAnimQueue(): Promise<void> {
  if (animDraining) return; // the running loop picks up whatever gets queued
  animDraining = true;
  try {
    while (animPending.size > 0) {
      if (displayDimmed) break;
      const context: string = animPending.values().next().value!;
      animPending.delete(context);
      const inst = instances.get(context);
      if (!inst) continue;
      // Rotate this key's start point into the cycle so neighbouring buttons do
      // not orbit as one block. The decks are an even sample of a full cycle, so
      // the rotation is a pure phase shift — no extra frames are rendered.
      const order = frameOrderFor(inst.key);
      const frames = order.map((f) => frameDecks()[f].get(inst.key)?.svg);
      if (frames.some((f) => !f)) continue;
      // This key's OWN first frame identifies its whole loop: every other frame is
      // a deterministic function of the same session state and the same rotation.
      // It must be read through `order[0]`, never deck 0 — see frameOrderFor.
      const cacheKey = frames[0]!;
      // Abandon only when THIS tile changed, not on any deck change at all. Most
      // renders during a live turn move some other key (a tool name, another
      // session's state) and leave this tile's pixels identical, so keying the
      // abort on `deckVersion` alone would restart the encode over and over and
      // an animation could never finish while anything else was busy.
      const tileChanged = () => frameDecks()[order[0]].get(inst.key)?.svg !== cacheKey;
      let gif = gifCache.get(cacheKey);
      const cached = gif !== undefined;
      const startedAt = Date.now();
      if (gif === undefined) {
        const encoded = await framesToGifBase64(
          { frames: frames as string[], delayMs: ANIM_DELAY_MS },
          GIF_ICON_SIZE,
          { get cancelled() { return tileChanged(); } },
        );
        if (tileChanged()) { animPending.add(context); continue; }
        if (!encoded) continue; // encode failed — the static PNG already on the key stands
        cacheGif(cacheKey, encoded);
        gif = encoded;
      }
      // The one line that tells a hardware session whether animation actually
      // landed: without it a key stuck on its static PNG is indistinguishable
      // from a key whose loop is playing.
      dlog(TAG, `gif ${inst.key} ${Math.round((gif.length * 3) / 4 / 1024)}KB `
        + (cached ? 'cached' : `encoded in ${Date.now() - startedAt}ms`));
      pushQueue.set(context, { dataUri: `data:image/gif;base64,${gif}`, isGif: true });
      ensureDrainer();
    }
  } catch (err) {
    derr(TAG, `anim encode failed: ${err}`);
  } finally {
    animDraining = false;
  }
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

  deckVersion++;

  const staticDeck = deckFor(0, false);
  // Compare the animated frame 0 against a half-cycle frame: a tile animates iff
  // those differ. Comparing against the STATIC tile would be wrong — `animated`
  // changes the border markup on its own, so every state tile would look animated.
  const animBaseDeck = ANIMATE ? deckFor(0, true) : null;
  const probeDeck = ANIMATE ? deckFor(ANIM_PROBE_FRAME, true) : null;

  // Enqueue changed keys; the drainer paces them to the device (a few per tick).
  // Blasting 12–13 keys at once on a view switch overruns the device — Studio's
  // UI updates but the hardware drops most, leaving stale keys.
  let changed = 0;
  let queuedAnim = 0;
  for (const inst of instances.values()) {
    try {
      const cell = staticDeck.get(inst.key);
      const staticSvg = cell?.svg ?? '';
      const animBase = animBaseDeck?.get(inst.key)?.svg ?? '';
      const animates = ANIMATE && !!cell && probeDeck!.get(inst.key)?.svg !== animBase;
      // A key that stopped animating must leave the queue, or a pending encode
      // would later overwrite its current static tile with a stale loop.
      if (!animates) animPending.delete(inst.context);
      const sig = `${animates ? 'A' : 'S'}|${staticSvg}`;
      if (sig === inst.lastSig) continue;
      inst.lastSig = sig;
      if (!cell) continue;
      // Full data URI — the device firmware needs the `data:` prefix to decode
      // (Studio's preview accepts bare base64, the hardware does not).
      const cachedGif = animates ? gifCache.get(animBase) : undefined;
      if (cachedGif !== undefined) {
        pushQueue.set(inst.context, { dataUri: `data:image/gif;base64,${cachedGif}`, isGif: true });
      } else {
        // Static tile now, GIF when it is encoded — a view switch stays instant
        // even when several tiles need a loop built from scratch.
        pushQueue.set(inst.context, { dataUri: `data:image/png;base64,${svgToBase64Png(staticSvg)}`, isGif: false });
        if (animates) { animPending.add(inst.context); queuedAnim++; }
      }
      changed++;
    } catch (err) {
      derr(TAG, `render ${inst.key} failed: ${err}`);
    }
  }
  if (changed > 0) {
    dlog(TAG, `queue ${changed} key(s), ${queuedAnim} to animate (view=${view.mode})`);
    ensureDrainer();
  }
  if (animPending.size > 0) void drainAnimQueue();
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
$UD.onClose(() => { dlog(TAG, 'Ulanzi Studio bridge closed'); cancelActiveHold('studio socket closed'); studioSupervisor.noteClosed(); });
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
  for (const it of items) {
    instances.delete(it.context);
    // A key that disappears mid-hold (page change, profile switch) would
    // otherwise leave the daemon capturing until its 30s cap.
    const dispatch = voiceHold.disappear(it.context);
    if (!dispatch) continue;
    const cmd = voiceCommandForAction(dispatch.action, dispatch.sessionId);
    if (cmd) { dlog(TAG, 'voice hold cancelled (key removed)'); daemon.send({ ...cmd }); }
  }
});

/** One hold at a time, shared with the Stream Deck key's semantics. */
const voiceHold = new VoicePttHold();

/**
 * End a hold whose key release can no longer reach us.
 *
 * The capture's whole lifetime is the keydown/keyUp pair, so anything that can
 * eat the release — Studio's socket dropping, the daemon link flapping — would
 * otherwise leave the daemon recording to its 30s cap and then delivering 30s
 * of room noise into the user's session as a prompt.
 */
function cancelActiveHold(why: string): void {
  const dispatch = voiceHold.cancelActive();
  if (!dispatch) return;
  const cmd = voiceCommandForAction(dispatch.action, dispatch.sessionId);
  dlog(TAG, `voice hold cancelled (${why})`);
  if (cmd) daemon.send({ ...cmd });
}

/** The voice command a key currently carries, if it is the VOICE tile. */
function voiceTargetFor(key: string): string | undefined {
  const action = deckFor(0, false).get(key)?.action;
  if (action?.kind !== 'command' || action.command.type !== 'voice') return undefined;
  return (action.command as { sessionId?: string }).sessionId ?? '';
}

function onPress(m: UlanziMessage): void {
  flog('RAW', 'press', m);
  const inst = instances.get(m.context);
  if (!inst) { flog(TAG, `press: no instance for context ${m.context} (key=${m.key})`); $UD.emit('add', m); return; }
  const known = positions().sort();
  flog(TAG, `press key=${inst.key} view=${view.mode} positions=[${known.join(',')}]`);
  // VOICE is hold-to-talk, driven by the keydown/keyUp pair below. `run` fires
  // for the same physical press, so it must not also fire the capture.
  if (voiceTargetFor(inst.key) !== undefined) { flog(TAG, `press ${inst.key} → voice (held, run ignored)`); return; }
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
// (~2ms apart, measured on hardware). Handle ONLY `run` (the SDK's documented
// main trigger) so a single press is a single action — wiring both double-fires
// and cancels out (open→back).
//
// VOICE is the one exception, and it has to be: a capture ends when the user
// lets go, which `run` cannot express. The device does deliver a truthful
// keydown/keyUp pair (measured: down 17:35:10.399, up 17:35:13.298 for a 2.9 s
// hold), so the VOICE key alone rides that pair and `run` skips it. This also
// takes the stop off the tile's state — the previous tap-toggle could only stop
// once `voice_state` had come back and repainted the key, so a user who simply
// held it, as they would on a Stream Deck, never stopped the capture at all.
$UD.onRun(onPress);



$UD.onKeyDown((m: UlanziMessage) => {
  // Recover an unknown context the same way `run` does. keydown precedes `run`
  // by ~2ms, so without this the first press after a re-add would be lost
  // entirely: keydown ignored, `run` registers the key and then skips it as a
  // VOICE tile, keyUp finds no hold.
  if (!instances.has(m.context)) $UD.emit('add', m);
  const inst = instances.get(m.context);
  const sessionId = inst ? voiceTargetFor(inst.key) : undefined;
  if (sessionId === undefined) { flog('RAW', 'keydown(ignored)', m.key); return; }
  voiceHold.begin(m.context, sessionId || undefined);
  const cmd = voiceCommandForAction('voice-ptt-begin', sessionId || undefined);
  if (cmd) { dlog(TAG, `voice hold begin on ${inst!.key}`); daemon.send({ ...cmd }); }
});

$UD.onKeyUp((m: UlanziMessage) => {
  const dispatch = voiceHold.release(m.context);
  if (!dispatch) { flog('RAW', 'keyUp(ignored)', m.key); return; }
  const cmd = voiceCommandForAction(dispatch.action, dispatch.sessionId);
  if (cmd) { dlog(TAG, `voice hold ${dispatch.action}`); daemon.send({ ...cmd }); }
});


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
daemon.on('disconnected', () => { dlog(TAG, 'daemon disconnected'); cancelActiveHold('daemon disconnected'); store.setConnected(false); view = { mode: 'list', page: 0 }; scheduleRender(); });
daemon.start();

dinfo(TAG, 'AgentDeck Ulanzi plugin started');
