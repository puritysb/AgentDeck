/**
 * D200H HID Device Module — communicates with Ulanzi D200H via stock HID protocol.
 *
 * The D200H boots into HID mode (VID 0x2207, PID 0x0019) after 4 seconds.
 * This module:
 *  - Detects the device via node-hid enumeration
 *  - Sends dashboard images via SET_BUTTONS (ZIP with manifest.json + PNGs)
 *  - Receives button press events and dispatches commands
 *  - Manages brightness and keep-alive
 *
 * No ADB, no firmware modification, no on-device agent needed.
 */

import type { DeviceModule, BridgeContext } from './types.js';
import { buildZipPackets, buildBrightnessPacket, buildSmallWindowPacket, parseIncoming } from '../d200h/hid-protocol.js';
import { renderDashboardZip, stateHash, initRenderer, isResvgLoaded, buildButtonCommandMap } from '../d200h/image-renderer.js';
import type { ButtonCommand } from '../d200h/image-renderer.js';
import { debug } from '../logger.js';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const TAG = 'd200h';

const VID = 0x2207;
const PID = 0x0019;
const CONSUMER_USAGE_PAGE = 12;
const KEYBOARD_USAGE_PAGE = 1;

const POLL_INTERVAL = 500;     // Device detection polling (ms)
const READ_INTERVAL = 20;      // HID read polling (ms)
const KEEPALIVE_INTERVAL = 30_000; // Keep-alive interval (ms)

// Button → command mapping is derived per-frame from the render layout
// (`buildButtonCommandMap`), so a key always does exactly what its rendered
// tile shows. See `currentCommandMap` below.

function isControllableSession(session: any): boolean {
  return !!session?.port && session.controlMode !== 'observed';
}

type HIDDevice = {
  write(data: Buffer | number[]): number;
  read(length?: number): number[] | Buffer;
  readTimeout?(timeout: number): number[] | Buffer;
  close(): void;
  on?(event: string, callback: (...args: any[]) => void): void;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
type HIDModule = {
  devices(...args: any[]): any[];
  HID: new (path: string) => HIDDevice;
};

export class D200hModule implements DeviceModule {
  readonly name = 'd200h';

  private hidModule: HIDModule | null = null;
  private consumerDevice: HIDDevice | null = null;
  private keyboardDevice: HIDDevice | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readTimer: ReturnType<typeof setInterval> | null = null;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private commandHandler: ((cmd: any) => void) | null = null;
  private lastStateHash = '';
  private lastState: any = {
    state: 'IDLE',
    projectName: '',
    modelName: '',
    mode: 'default',
    agentType: 'daemon',
    fiveHourPercent: 0,
    sevenDayPercent: 0,
    totalTokens: 0,
    totalCost: 0,
    options: [],
    currentTool: '',
  };
  private lastSessions: any[] = [];
  private hostDisplayOn = true;
  private dimEnabled = true;
  private dimMode: 'off' | 'min' = 'off';
  private dimLevel = 10;
  private lastDimSignature = '';
  private displaySuppressed = false;
  // When true, the Ulanzi Studio plugin owns the D200H — direct-HID stands down
  // (releases the device, suspends reconnect) so the two don't fight over it.
  private externalOwner = false;
  // Physical-key index → command for the currently displayed frame. Rebuilt
  // from the render layout on every updateDisplay so input matches the pixels.
  private currentCommandMap: Map<number, ButtonCommand> = new Map();
  private connected = false;
  private isUpdating = false;
  private pendingUpdate: any = null;
  private writeOK = 0;
  private writeFail = 0;
  private buttonPressCount = 0;
  private hidReportCount = 0;
  private lastWriteError: string | null = null;
  private lastOpenError: string | null = null;

  async shouldActivate(config: 'auto' | boolean): Promise<boolean> {
    if (config === false) return false;

    try {
      this.hidModule = await this.loadHidModule();
      if (!this.hidModule) return false;

      if (config === true) return true;

      // auto: check if D200H is connected
      return this.findDevice() !== null;
    } catch {
      return false;
    }
  }

  async start(ctx: BridgeContext): Promise<void> {
    debug(TAG, 'Starting D200H HID module');

    // Initialize SVG renderer (loads resvg-js if available)
    await initRenderer();

    // Wire command handler
    this.commandHandler = (cmd) => ctx.wsServer.dispatchCommand(cmd);

    // Forward state broadcasts to display
    ctx.wsServer.onBroadcast((evt: any) => {
      if (evt?.type === 'state_update') {
        this.lastState = evt;
        this.updateDisplay({ ...this.lastState, allSessions: this.lastSessions }).catch(() => {});
      } else if (evt?.type === 'usage_update') {
        // Usage (5H/7D/tokens/cost) rides usage_update, NOT state_update — merge it
        // in so the gauges aren't stuck at 0 (same gap fixed in the TRMNL module).
        this.lastState = {
          ...this.lastState,
          fiveHourPercent: evt.fiveHourPercent,
          sevenDayPercent: evt.sevenDayPercent,
          fiveHourResetsAt: evt.fiveHourResetsAt,
          sevenDayResetsAt: evt.sevenDayResetsAt,
          // Tri-state: distinguish "0% used" from "no quota data" so the gauges
          // draw a "—" instead of a confident 0% (matches TRMNL / Ulanzi deck).
          usageKnown: evt.usageStale === true
            ? false
            : (evt.fiveHourPercent != null || evt.sevenDayPercent != null),
          totalTokens: evt.totalTokens ?? ((evt.inputTokens ?? 0) + (evt.outputTokens ?? 0)),
          totalCost: evt.totalCost ?? evt.estimatedCostUsd ?? this.lastState?.totalCost ?? 0,
        };
        this.updateDisplay({ ...this.lastState, allSessions: this.lastSessions }).catch(() => {});
      } else if (evt?.type === 'sessions_list') {
        this.lastSessions = (evt.sessions ?? []).filter(isControllableSession);
        if (this.lastState) {
          this.updateDisplay({ ...this.lastState, allSessions: this.lastSessions }).catch(() => {});
        }
      } else if (evt?.type === 'display_state') {
        this.applyDisplayState(evt);
      }
    });

    // Stand down direct-HID whenever the Ulanzi Studio plugin is connected, so
    // the daemon and Ulanzi Studio never drive the same device at once. Fires
    // immediately with the current state.
    ctx.wsServer.onUlanziPluginPresence((present) => this.setExternalOwner(present));

    // Start device detection polling
    this.tryConnect();
    this.pollTimer = setInterval(() => {
      if (!this.connected && !this.externalOwner) {
        this.tryConnect();
      }
    }, POLL_INTERVAL);
  }

  async stop(): Promise<void> {
    debug(TAG, 'Stopping D200H HID module');

    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.readTimer) { clearInterval(this.readTimer); this.readTimer = null; }
    if (this.keepAliveTimer) { clearInterval(this.keepAliveTimer); this.keepAliveTimer = null; }

    if (this.connected) {
      this.isUpdating = false;
      this.lastStateHash = '';
      await this.updateDisplay({ ...this.lastState, state: 'DISCONNECTED', allSessions: this.lastSessions }).catch(() => {});
    }

    this.disconnect();
    this.commandHandler = null;
  }

  statusSnapshot(): Record<string, unknown> {
    return {
      connected: this.connected,
      externalOwner: this.externalOwner,
      managerOpened: this.hidModule !== null,
      resvgLoaded: isResvgLoaded(),
      writeOK: this.writeOK,
      writeFail: this.writeFail,
      buttonPressCount: this.buttonPressCount,
      hidReportCount: this.hidReportCount,
      lastWriteError: this.lastWriteError,
      lastOpenError: this.lastOpenError,
    };
  }

  // --- Private methods ---

  private async loadHidModule(): Promise<HIDModule | null> {
    try {
      const mod = await import('node-hid');
      return (mod.default ?? mod) as any as HIDModule;
    } catch {
      debug(TAG, 'node-hid not available');
      return null;
    }
  }

  private findDevice(): { consumerPath: string; keyboardPath?: string; serial: string } | null {
    if (!this.hidModule) return null;

    const devices = this.hidModule.devices();
    let consumerPath: string | undefined;
    let keyboardPath: string | undefined;
    let serial = '';

    for (const d of devices) {
      if (d.vendorId === VID && d.productId === PID) {
        serial = d.serialNumber ?? '';
        if (d.usagePage === CONSUMER_USAGE_PAGE) {
          consumerPath = d.path;
        } else if (d.usagePage === KEYBOARD_USAGE_PAGE) {
          keyboardPath = d.path;
        }
      }
    }

    if (consumerPath) {
      return { consumerPath, keyboardPath, serial };
    }
    return null;
  }

  /**
   * Arbitrate device ownership with the Ulanzi Studio plugin. When it connects,
   * release the D200H and suspend reconnect so Ulanzi Studio drives it; when it
   * disconnects, resume direct-HID.
   */
  setExternalOwner(owner: boolean): void {
    if (this.externalOwner === owner) return;
    this.externalOwner = owner;
    if (owner) {
      debug(TAG, 'Ulanzi plugin active — releasing D200H to Ulanzi Studio');
      if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
      this.disconnect();
    } else {
      debug(TAG, 'Ulanzi plugin gone — resuming direct-HID');
      if (!this.pollTimer) {
        this.pollTimer = setInterval(() => {
          if (!this.connected && !this.externalOwner) this.tryConnect();
        }, POLL_INTERVAL);
      }
      this.tryConnect();
    }
  }

  private tryConnect(): void {
    if (this.externalOwner) return;
    if (!this.hidModule) return;

    const info = this.findDevice();
    if (!info) return;

    try {
      // Open consumer control interface (display updates + some events)
      this.consumerDevice = new this.hidModule.HID(info.consumerPath);
      this.lastOpenError = null;
      debug(TAG, `Connected to D200H (serial: ${info.serial}) via Consumer Control`);

      // Try to open keyboard interface (button events) — may fail on macOS
      if (info.keyboardPath) {
        try {
          this.keyboardDevice = new this.hidModule.HID(info.keyboardPath);
          debug(TAG, 'Opened keyboard interface for button events');
        } catch (err: any) {
          const errMsg = err?.message ?? String(err);
          this.lastOpenError = `macOS Input Monitoring Permission Required: Please enable Input Monitoring for your terminal (e.g., iTerm, Terminal) in System Settings -> Privacy & Security -> Input Monitoring. (Error: ${errMsg})`;
          debug(TAG, `Keyboard interface not available: ${this.lastOpenError}`);

          // Trigger system preferences open once to guide the user
          if (process.platform === 'darwin') {
            import('child_process').then(({ exec }) => {
              exec('open "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"', (e) => {
                if (e) debug(TAG, `Failed to open System Settings: ${e.message}`);
              });
            }).catch(() => {});
          }
        }
      }

      this.connected = true;

      // Start reading events
      // If keyboard interface failed to open, buttons won't register, but
      // readFrom still safely monitors events that might come via consumer control.
      this.startReading();

      // Start keep-alive
      this.keepAliveTimer = setInterval(() => this.sendKeepAlive(), KEEPALIVE_INTERVAL);

      // Set initial brightness, honoring a cached display_state if the host
      // was already asleep when the D200H reconnected.
      this.applyDisplayBrightness();

      // Send initial display update (render offline/idle layout immediately)
      this.updateDisplay(this.lastState).catch((err) => {
        debug(TAG, `Initial display update failed: ${err}`);
      });
    } catch (err) {
      this.lastOpenError = String(err);
      debug(TAG, `Failed to connect: ${err}`);
      this.disconnect();
    }
  }

  private disconnect(): void {
    if (this.readTimer) { clearInterval(this.readTimer); this.readTimer = null; }
    if (this.keepAliveTimer) { clearInterval(this.keepAliveTimer); this.keepAliveTimer = null; }
    try { this.consumerDevice?.close(); } catch { /* ignore */ }
    try { this.keyboardDevice?.close(); } catch { /* ignore */ }
    this.consumerDevice = null;
    this.keyboardDevice = null;
    this.connected = false;
    this.lastStateHash = '';
  }

  private startReading(): void {
    if (this.readTimer) { clearInterval(this.readTimer); }

    this.readTimer = setInterval(() => {
      this.readFrom(this.consumerDevice);
      this.readFrom(this.keyboardDevice);
    }, READ_INTERVAL);
  }

  private readFrom(device: HIDDevice | null): void {
    if (!device) return;

    try {
      // Use readTimeout for non-blocking behavior (node-hid v3+)
      const data = device.readTimeout ? device.readTimeout(1) : device.read();
      if (!data || (Array.isArray(data) && data.length === 0) || (Buffer.isBuffer(data) && data.length === 0)) return;

      const buf = Buffer.from(data as any);
      const event = parseIncoming(buf);
      if (!event) return;
      this.hidReportCount++;

      if (event.type === 'button' && event.data.pressed) {
        this.buttonPressCount++;
        // Real button input received → input path is empirically working.
        // Clear any stale lastOpenError left by a failed keyboard-interface open
        // (buttons arrive via the consumer-control interface regardless).
        if (this.lastOpenError) this.lastOpenError = null;

        // The command is whatever the currently-displayed tile at this physical
        // key does — derived from the same layout that was rendered, so the key
        // can never act on stale or mismatched session ordering.
        const cmd = this.currentCommandMap.get(event.data.index);
        if (cmd) {
          debug(TAG, `Button ${event.data.index} pressed → ${cmd.type}`);
          this.commandHandler?.(cmd);
        } else {
          debug(TAG, `Button ${event.data.index} pressed (inert tile)`);
        }
      } else if (event.type === 'device_info') {
        debug(TAG, `Device: ${event.data.deviceType} fw=${event.data.firmwareVersion} hw=${event.data.hardwareVersion}`);
      }
    } catch (err: any) {
      const msg = err?.message ?? '';
      if (msg.includes('could not read') || msg.includes('disconnected') || msg.includes('transfer')) {
        debug(TAG, `Device disconnected (${msg})`);
        this.disconnect();
      } else {
        debug(TAG, `HID read error: ${msg}`);
      }
    }
  }

  private async updateDisplay(stateEvt: any): Promise<void> {
    const hash = stateHash(stateEvt);
    if (hash === this.lastStateHash) return;
    
    if (this.isUpdating) {
      this.pendingUpdate = stateEvt;
      return;
    }

    this.lastStateHash = hash;
    this.isUpdating = true;

    try {
      const zip = renderDashboardZip(stateEvt);
      // Rebuild the input map from the SAME state we just rendered, so a press
      // always maps to what is currently on screen.
      this.currentCommandMap = buildButtonCommandMap(stateEvt);

      // Save ZIP to ~/.agentdeck/d200h-dumps/ for preview
      try {
        const dumpDir = join(homedir(), '.agentdeck', 'd200h-dumps');
        if (!existsSync(dumpDir)) {
          mkdirSync(dumpDir, { recursive: true });
        }
        const stamp = new Date().toISOString().replace(/[-T:]/g, '').split('.')[0];
        const modeKey = (stateEvt?.mode || 'default').toLowerCase();
        const sanitizedState = (stateEvt?.state || 'unknown').toLowerCase().replace(/[^a-z0-9_-]/g, '');
        const sanitizedProject = (stateEvt?.projectName || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
        const sanitized = [sanitizedState, sanitizedProject].filter(Boolean).join('-');
        const filename = `${stamp}-set_buttons-${modeKey}-${zip.length}b-${sanitized}.zip`;
        writeFileSync(join(dumpDir, filename), zip);
      } catch (dumpErr) {
        debug(TAG, `Failed to dump ZIP to ~/.agentdeck/d200h-dumps/: ${dumpErr}`);
      }

      const packets = buildZipPackets(zip);

      for (const pkt of packets) {
        if (!this.connected) break;
        if (!this.writeToDevice(pkt)) {
          throw new Error(this.lastWriteError ?? 'D200H write failed');
        }
        await new Promise(r => setTimeout(r, 8)); // Prevent hardware buffer overflow
      }

      debug(TAG, `Display updated: ${zip.length} bytes, ${packets.length} packets`);
    } catch (err) {
      debug(TAG, `Display update failed: ${err}`);
      this.lastStateHash = ''; // Reset hash so it can retry
    } finally {
      this.isUpdating = false;
      if (this.pendingUpdate) {
        const next = this.pendingUpdate;
        this.pendingUpdate = null;
        void this.updateDisplay(next).catch(() => {});
      }
    }
  }

  private sendKeepAlive(): void {
    if (!this.connected) return;

    const now = new Date();
    const timeStr = now.toTimeString().slice(0, 8);
    const packet = buildSmallWindowPacket(1, 0, 0, timeStr, 0);
    this.writeToDevice(packet);
  }

  private applyDisplayState(evt: any): void {
    const dim = evt?.dim as Record<string, unknown> | undefined;
    this.hostDisplayOn = evt?.displayOn ?? true;
    const rawEnabled = dim?.enabled;
    this.dimEnabled = typeof rawEnabled === 'boolean' ? rawEnabled : true;
    this.dimMode = dim?.mode === 'min' ? 'min' : 'off';
    const rawLevel = dim?.level;
    const level = typeof rawLevel === 'number' && Number.isFinite(rawLevel) ? Math.round(rawLevel) : 10;
    this.dimLevel = Math.max(1, Math.min(100, level));

    const signature = `${this.hostDisplayOn}|${this.dimEnabled}|${this.dimMode}|${this.dimLevel}`;
    if (signature === this.lastDimSignature) return;
    this.lastDimSignature = signature;
    this.applyDisplayBrightness();
  }

  private applyDisplayBrightness(): void {
    if (!this.connected) return;
    const shouldSuppress = !this.hostDisplayOn && this.dimEnabled;
    const target = shouldSuppress ? (this.dimMode === 'min' ? this.dimLevel : 0) : 100;
    const wasSuppressed = this.displaySuppressed;
    this.displaySuppressed = shouldSuppress;
    this.writeToDevice(buildBrightnessPacket(target));
    debug(TAG, `Display ${this.hostDisplayOn ? 'wake' : 'sleep'} — brightness ${target}`);
    if (wasSuppressed && !shouldSuppress) {
      this.lastStateHash = '';
      this.updateDisplay({ ...this.lastState, allSessions: this.lastSessions }).catch(() => {});
    }
  }

  private writeToDevice(packet: Buffer): boolean {
    if (!this.consumerDevice) return false;

    try {
      // node-hid on macOS requires the first byte to be the Report ID.
      // If the device does not use Report IDs (like D200H), the first byte must be 0x00.
      // node-hid will strip this 0x00 before sending the remaining 1024 bytes to the device.
      const dataToWrite = [0x00, ...Array.from(packet)];
      this.consumerDevice.write(dataToWrite);
      this.writeOK++;
      this.lastWriteError = null;
      return true;
    } catch (err: any) {
      this.writeFail++;
      this.lastWriteError = err?.message ?? String(err);
      if (err?.message?.includes('could not write') || err?.message?.includes('could not send')) {
        debug(TAG, 'Write failed — device disconnected');
        this.disconnect();
      }
      return false;
    }
  }
}
