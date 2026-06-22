/**
 * TRMNL device module — keeps the BYOS frame cache fresh.
 *
 * TRMNL is a WiFi e-ink display that PULLS rendered images from a server on its
 * own schedule (the BYOS /api/display contract), so unlike Pixoo/D200H this
 * module never pushes to hardware. It only subscribes to AgentDeck state
 * broadcasts and re-renders the cached 800×480 1-bit frame when the visual state
 * changes; the daemon's HTTP routes (bridge/src/trmnl/byos-server.ts) serve that
 * frame when a device polls.
 *
 * Rendering is gated on a device being registered (or `trmnl.enabled`) so a
 * machine with no TRMNL panel does no extra rasterization. The gate is refreshed
 * from settings on a short interval and immediately when a device enrolls.
 */
import type { DeviceModule, BridgeContext } from './types.js';
import { initTrmnlRenderer, isTrmnlResvgLoaded } from '../trmnl/image-renderer.js';
import { refreshTrmnlFrame, setTrmnlState, getTrmnlFrameKeys, getTrmnlActivity } from '../trmnl/frame-cache.js';
import { loadTrmnlConfig, effectiveRefreshRate } from '../trmnl/trmnl-settings.js';
import { getTelemetryHealth } from '../trmnl/trmnl-telemetry.js';
import { debug } from '../logger.js';

const TAG = 'trmnl';
const GATE_REFRESH_MS = 30_000;

function isControllableOrObserved(session: any): boolean {
  // TRMNL is a read-only dashboard — show every live session (controllable or
  // observed), unlike D200H which filters to controllable for its buttons.
  return !!session && session.alive !== false;
}

export class TrmnlModule implements DeviceModule {
  readonly name = 'trmnl';

  private lastState: any = null;
  private lastUsage: any = null;
  private lastSessions: any[] = [];
  private gateActive = false;
  private gateTimer: ReturnType<typeof setInterval> | null = null;

  async shouldActivate(config: 'auto' | boolean): Promise<boolean> {
    if (config === false) return false;
    if (config === true) return true;
    // auto: active if a device is registered or the user forced it on.
    const cfg = loadTrmnlConfig();
    return cfg.enabled || cfg.devices.length > 0;
  }

  async start(ctx: BridgeContext): Promise<void> {
    await initTrmnlRenderer();
    this.refreshGate();
    this.gateTimer = setInterval(() => this.refreshGate(), GATE_REFRESH_MS);

    ctx.wsServer.onBroadcast((evt: any) => {
      if (evt?.type === 'state_update') {
        this.lastState = evt;
        this.render();
      } else if (evt?.type === 'usage_update') {
        // state_update never carries usage; the 5H/7D gauges + token/cost footer
        // only exist on usage_update (same as Pixoo/ESP32). Without this the panel
        // renders a confident 0% forever.
        this.lastUsage = evt;
        this.render();
      } else if (evt?.type === 'sessions_list') {
        this.lastSessions = (evt.sessions ?? []).filter(isControllableOrObserved);
        this.render();
      }
    });

    debug(TAG, `started (resvg=${isTrmnlResvgLoaded()}, gate=${this.gateActive})`);
  }

  async stop(): Promise<void> {
    if (this.gateTimer) {
      clearInterval(this.gateTimer);
      this.gateTimer = null;
    }
  }

  statusSnapshot(): Record<string, unknown> {
    const cfg = loadTrmnlConfig();
    const activeResolutions = getTrmnlFrameKeys();
    const activity = getTrmnlActivity();
    const currentRefreshRate = effectiveRefreshRate(cfg, activity);
    return {
      resvgLoaded: isTrmnlResvgLoaded(),
      gateActive: this.gateActive,
      enabled: cfg.enabled,
      deviceCount: cfg.devices.length,
      refreshRate: cfg.refreshRate,
      refreshActive: cfg.refreshActive,
      currentRefreshRate,
      activeResolutions,
      frameCount: activeResolutions.length,
      // Health uses the current adaptive cadence so "stale" tracks real expectations.
      telemetry: getTelemetryHealth(currentRefreshRate),
    };
  }

  /** Re-read settings to decide whether rendering is worthwhile. */
  private refreshGate(): void {
    const cfg = loadTrmnlConfig();
    this.gateActive = cfg.enabled || cfg.devices.length > 0;
  }

  private render(): void {
    const evt = this.buildRenderState();
    if (!this.gateActive) {
      // No device yet — remember the state so the frame is correct the instant a
      // device enrolls (byos-server forces a render then), but skip rasterizing.
      setTrmnlState(evt);
      return;
    }
    refreshTrmnlFrame(evt);
  }

  /**
   * Combine the latest state_update + usage_update + sessions into one render
   * event. usage_update is spread last so its 5H/7D + reset fields win. No time
   * component is added: the frame hash must change only on real visual change so
   * a real TRMNL can skip the (battery + flaky-WiFi) re-download otherwise.
   */
  private buildRenderState(): any {
    const u = this.lastUsage ?? {};
    // Usage is "known" only when the hub actually has subscription quota (the
    // gauges are meaningful); otherwise the layout renders "—" instead of 0%.
    const usageKnown = u.fiveHourPercent != null || u.sevenDayPercent != null;
    return {
      ...(this.lastState ?? {}),
      ...u,
      usageKnown,
      allSessions: this.lastSessions,
    };
  }
}
