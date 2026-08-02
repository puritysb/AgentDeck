/**
 * E4 — Launcher dial (Stream Deck+).
 *
 * Rotate rolls through the configured agents; press opens that agent's app or
 * web UI. The list is static and depends on no daemon state, so the dial behaves
 * identically on a fresh install and on a fully wired setup.
 *
 * This encoder replaced the push-to-talk Voice dial ahead of the Marketplace
 * submission. Voice recording depended on borrowing iTerm2's microphone grant
 * via AppleScript plus Homebrew `sox` and a local whisper model — none of which
 * a reviewer (or a typical user) has, so it failed silently on a clean machine.
 * Launching an app is the same interaction shape with none of that fragility.
 *
 * A "focus the live session" tier was prototyped and dropped: the daemon knows a
 * session's port and cwd but not which terminal window renders it, so focusing
 * meant substring-matching iTerm2 session names against project names — which
 * silently activates the wrong window whenever two projects share a name prefix.
 */
import streamDeck, {
  action,
  SingletonAction,
  DialRotateEvent,
  DialDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
  DidReceiveSettingsEvent,
} from '@elgato/streamdeck';
import { encoderRegistry, isDaemonConnected } from '../encoder-registry.js';
import { svgToDataUrl } from '../renderers/button-renderer.js';
import { renderLauncher, renderLauncherEmpty, type LauncherRenderData } from '../renderers/launcher-renderer.js';
import { renderOfflineTouchStrip } from '../renderers/session-slot-renderer.js';
import { dlog, dinfo, dwarn } from '../log.js';
import { isDisplayDimmed, dimActionIfNeeded } from '../display-dim.js';
import { openAgentDeckAppOrGitHub } from '../system/index.js';
import { buildEntries, rollIndex, runTarget } from '../launch-targets.js';

import type { JsonValue } from '@elgato/utils';

const PIXMAP_LAYOUT = 'layouts/encoder-layout.json';

interface LauncherSettings {
  [key: string]: JsonValue;
  claudeTarget?: string;
  codexTarget?: string;
  openclawTarget?: string;
}

let settings: LauncherSettings = {};
let index = 0;
let currentLayout = '';

function entries() {
  return buildEntries(settings);
}

export function initLauncherDial(): void {
  dinfo('Launcher', 'initLauncherDial');
  refreshLauncherDials();
}

export function updateLauncherDialState(): void {
  currentLayout = '';
  refreshLauncherDials();
}

function ensurePixmapLayout(): void {
  if (currentLayout === PIXMAP_LAYOUT) return;
  currentLayout = PIXMAP_LAYOUT;
  for (const id of encoderRegistry.launcherIds) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (dial) void dial.setFeedbackLayout(PIXMAP_LAYOUT).catch(() => {});
  }
}

export function refreshLauncherDials(): void {
  if (isDisplayDimmed()) return;
  if (!isDaemonConnected()) {
    ensurePixmapLayout();
    const canvasFeedback = { canvas: svgToDataUrl(renderOfflineTouchStrip(3)) };
    for (const id of encoderRegistry.launcherIds) {
      const dial = streamDeck.actions.getActionById(id) as any;
      if (dial) void dial.setFeedback(canvasFeedback).catch(() => {});
    }
    return;
  }

  ensurePixmapLayout();

  const list = entries();
  let svg: string;
  if (list.length === 0) {
    svg = renderLauncherEmpty();
  } else {
    const pos = Math.min(index, list.length - 1);
    const data: LauncherRenderData = {
      label: list[pos].label,
      detail: 'Open',
      position: pos + 1,
      total: list.length,
    };
    svg = renderLauncher(data);
  }

  const canvasFeedback = { canvas: svgToDataUrl(svg) };
  for (const id of encoderRegistry.launcherIds) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (dial) void dial.setFeedback(canvasFeedback).catch(() => {});
  }
}

@action({ UUID: 'bound.serendipity.agentdeck.launcher' })
export class LauncherDialAction extends SingletonAction {
  static get actionIds(): string[] { return encoderRegistry.launcherIds; }

  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    dinfo('Launcher', `onWillAppear: id=${ev.action.id} controller=${ev.payload.controller}`);
    if (!encoderRegistry.launcherIds.includes(ev.action.id)) {
      encoderRegistry.launcherIds.push(ev.action.id);
    }
    settings = (ev.payload?.settings ?? {}) as LauncherSettings;
    if (dimActionIfNeeded(ev.action, 'Encoder')) return;
    refreshLauncherDials();
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<LauncherSettings>): void {
    settings = ev.payload.settings;
    refreshLauncherDials();
  }

  override async onDialRotate(ev: DialRotateEvent): Promise<void> {
    if (!isDaemonConnected()) return;

    const list = entries();
    if (list.length === 0) return;
    // Wrap in both directions so a long roll never dead-ends.
    index = rollIndex(index, ev.payload.ticks, list.length);
    dlog('Launcher', `rotate: idx=${index}/${list.length}`);
    refreshLauncherDials();
  }

  override async onDialDown(ev: DialDownEvent): Promise<void> {
    if (!isDaemonConnected()) {
      void openAgentDeckAppOrGitHub().catch(() => {});
      return;
    }

    const list = entries();
    if (list.length === 0) return;
    const entry = list[Math.min(index, list.length - 1)];

    try {
      dlog('Launcher', `launch ${entry.agent}: ${entry.target}`);
      await runTarget(entry.target);
    } catch (err) {
      // A missing app or an unreachable URL must not be a silent no-op.
      dwarn('Launcher', `press failed: ${err}`);
      void (ev.action as any).showAlert?.().catch(() => {});
    }
    refreshLauncherDials();
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    const idx = encoderRegistry.launcherIds.indexOf(ev.action.id);
    if (idx !== -1) {
      encoderRegistry.launcherIds.splice(idx, 1);
    }
  }
}