/**
 * E1 — Volume dial (Stream Deck+).
 *
 * Rotate adjusts system output volume (osascript on macOS, a PowerShell
 * CoreAudio coprocess on Windows — see `../system/`); press toggles mute. The
 * LCD shows the current level and mirrors changes made elsewhere on the system
 * via a 2s poll. When the platform backend reports volume unsupported (e.g.
 * Windows with Add-Type blocked), the dial renders an N/A face and stops
 * polling instead of failing silently every 2s.
 *
 * The multi-mode utility dial (mic / media / timer / diag / apme / tower, cycled
 * by tapping the LCD) was removed ahead of the Marketplace submission: touch-tap
 * mode switching was undiscoverable, did nothing at the default single-mode
 * setting, and the extra modes leaned on `System Events` synthetic key codes
 * (Accessibility permission) that fail silently when the grant is missing.
 * The UUID stays `utility-dial` for profile/manifest stability.
 */
import streamDeck, {
  action,
  SingletonAction,
  DialRotateEvent,
  DialDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from '@elgato/streamdeck';
import { State } from '@agentdeck/shared';
import { encoderRegistry, isDaemonConnected } from '../encoder-registry.js';
import { svgToDataUrl } from '../renderers/button-renderer.js';
import { renderUtilityGeneric, type UtilityRenderData } from '../renderers/utility-renderer.js';
import { dlog, dinfo, dwarn } from '../log.js';
import { isDisplayDimmed, dimActionIfNeeded } from '../display-dim.js';
import {
  openAgentDeckAppOrGitHub,
  getVolumeSettings,
  setOutputVolume,
  setOutputMuted,
  isVolumeSupported,
} from '../system/index.js';
import { renderOfflineTouchStrip } from '../renderers/session-slot-renderer.js';

const PIXMAP_LAYOUT = 'layouts/encoder-layout.json';

const POLL_INTERVAL = 2000;
/** Skip polling briefly after a user action so the optimistic value isn't clobbered. */
const SKIP_AFTER_ACTION = 3000;
const VOLUME_STEP = 1;

let currentLayout = '';
let volume = 50;
let muted = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastActionAt = 0;
let polling = false;
/** null = not yet probed (optimistic). Flips false only via the platform backend. */
let volumeSupported: boolean | null = null;

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

async function syncFromSystem(): Promise<void> {
  if (polling || volumeSupported === false) return;
  if (Date.now() - lastActionAt < SKIP_AFTER_ACTION) return;
  polling = true;
  try {
    const s = await getVolumeSettings();
    if (s.outputVolume !== volume || s.outputMuted !== muted) {
      volume = s.outputVolume;
      muted = s.outputMuted;
      refreshUtilityDials();
    }
  } catch (err) {
    dwarn('VolumeDial', `syncFromSystem failed: ${err}`);
    // Late failure path: the Windows coprocess breaker can trip after startup.
    if (!(await isVolumeSupported())) {
      volumeSupported = false;
      stopPolling();
      refreshUtilityDials();
    }
  } finally {
    polling = false;
  }
}

function startPolling(): void {
  stopPolling();
  pollTimer = setInterval(() => { void syncFromSystem(); }, POLL_INTERVAL);
}

function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}


export function initUtilityDial(): void {
  dinfo('VolumeDial', 'initUtilityDial');
  void isVolumeSupported().then((supported) => {
    volumeSupported = supported;
    if (!supported) {
      refreshUtilityDials();
      return;
    }
    void syncFromSystem().then(() => refreshUtilityDials());
    startPolling();
  });
}

export function updateUtilityDialState(_state: State): void {
  // Volume is session-independent; the offline banner keys off isDaemonConnected().
  // Force a layout re-apply on the next refresh.
  currentLayout = '';
  refreshUtilityDials();
}

function ensurePixmapLayout(): void {
  if (currentLayout === PIXMAP_LAYOUT) return;
  currentLayout = PIXMAP_LAYOUT;
  for (const id of encoderRegistry.utilityIds) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (dial) void dial.setFeedbackLayout(PIXMAP_LAYOUT).catch(() => {});
  }
}

export function refreshUtilityDials(): void {
  // The volume poll timer keeps firing while the host display sleeps.
  if (isDisplayDimmed()) return;
  // Offline banner is highest priority and all-or-nothing across the encoders.
  // Gate on real daemon-down, NOT session-level currentState === DISCONNECTED
  // (which flips transiently during multi-session switching while the daemon is up).
  if (!isDaemonConnected()) {
    ensurePixmapLayout();
    const canvasFeedback = { canvas: svgToDataUrl(renderOfflineTouchStrip(0)) };
    for (const id of encoderRegistry.utilityIds) {
      const dial = streamDeck.actions.getActionById(id) as any;
      if (dial) void dial.setFeedback(canvasFeedback).catch(() => {});
    }
    return;
  }

  ensurePixmapLayout();

  const data: UtilityRenderData = volumeSupported === false
    ? {
      // Volume control unavailable (e.g. Windows PowerShell Add-Type blocked):
      // an honest N/A face beats a fake percentage that nothing updates.
      title: 'VOL',
      value: 'N/A',
      indicator: { value: 0, bar_fill_c: '#64748b' },
    }
    : {
      title: 'VOL',
      icon: muted ? '🔇' : '🔊',
      value: muted ? 'Muted' : `${volume}%`,
      indicator: {
        value: muted ? 0 : volume,
        bar_fill_c: muted ? '#64748b' : '#22c55e',
      },
    };

  const canvasFeedback = { canvas: svgToDataUrl(renderUtilityGeneric(data)) };
  for (const id of encoderRegistry.utilityIds) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (dial) void dial.setFeedback(canvasFeedback).catch(() => {});
  }
}

@action({ UUID: 'bound.serendipity.agentdeck.utility-dial' })
export class UtilityDialAction extends SingletonAction {
  static get actionIds(): string[] { return encoderRegistry.utilityIds; }

  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    dinfo('VolumeDial', `onWillAppear: id=${ev.action.id} controller=${ev.payload.controller}`);
    if (!encoderRegistry.utilityIds.includes(ev.action.id)) {
      encoderRegistry.utilityIds.push(ev.action.id);
    }
    if (volumeSupported === null) volumeSupported = await isVolumeSupported();
    if (volumeSupported) {
      await syncFromSystem();
      startPolling();
    }
    if (dimActionIfNeeded(ev.action, 'Encoder')) return;
    refreshUtilityDials();
  }

  override async onDialRotate(ev: DialRotateEvent): Promise<void> {
    if (!isDaemonConnected()) return;
    if (volumeSupported === false) return;

    // Rotation is high-frequency: the underlying setter is debounced and
    // fire-and-forget, so a failed tick surfaces as the poll snapping the
    // value back rather than as a per-tick alert.
    lastActionAt = Date.now();
    volume = clamp(volume + ev.payload.ticks * VOLUME_STEP, 0, 100);
    muted = false;
    setOutputVolume(volume);
    dlog('VolumeDial', `rotate: ${volume}%`);
    refreshUtilityDials();
  }

  override async onDialDown(ev: DialDownEvent): Promise<void> {
    if (!isDaemonConnected()) {
      void openAgentDeckAppOrGitHub().catch(() => {});
      return;
    }
    if (volumeSupported === false) {
      // Discrete, user-initiated action on a dead control — surface it.
      void (ev.action as any).showAlert?.().catch(() => {});
      return;
    }

    lastActionAt = Date.now();
    const next = !muted;
    try {
      await setOutputMuted(next);
      muted = next;
      dlog('VolumeDial', `push: muted=${muted}`);
    } catch (err) {
      // Discrete, user-initiated action — a silent no-op here reads as a broken
      // dial, so surface it on the key per the Elgato feedback guideline.
      dwarn('VolumeDial', `setOutputMuted failed: ${err}`);
      void (ev.action as any).showAlert?.().catch(() => {});
    }
    refreshUtilityDials();
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    dinfo('VolumeDial', `onWillDisappear: id=${ev.action.id}`);
    const idx = encoderRegistry.utilityIds.indexOf(ev.action.id);
    if (idx !== -1) {
      encoderRegistry.utilityIds.splice(idx, 1);
    }
    if (encoderRegistry.utilityIds.length === 0) {
      stopPolling();
    }
  }
}
