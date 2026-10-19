/**
 * ESP32 serial bridge (Node.js side) — protocol and filtering tests.
 *
 * Tests the actual serial bridge source functions (prepareForSerial,
 * handleSerialLine, port patterns) without requiring real serial hardware.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as logger from '../logger.js';
import { SERIAL_FORWARDED_EVENTS, DISPLAY_FORWARDED_EVENTS } from '@agentdeck/shared/protocol';
import type {
  StateUpdateEvent,
  UsageEvent,
  BridgeEvent,
  WifiProvisionMessage,
} from '@agentdeck/shared/protocol';
import { State, PermissionMode, type TimelineEntry } from '@agentdeck/shared';
import ciProjection from '../../../shared/ci-wait-projection-vectors.json';
import {
  prepareForSerial,
  roundRobinByAgentType,
  SERIAL_SESSIONS_CAP,
  handleSerialLine,
  capturePanicLine,
  isVoiceDiagnosticLine,
  isRetryableSerialIoError,
  ESP32_PORT_PATTERNS,
  EXCLUDE_PATTERNS,
  isUnidentifiedForeign,
  isHalfOpenIdentifiedCdc,
  isSilentIdentifiedUart,
  sanitizeRssiDbm,
  SERIAL_KEEPALIVE_JSON,
  budgetTimelineEntries,
  serialOpenFailureBackoffMs,
  TIMELINE_HISTORY_BYTE_BUDGET,
  shouldSendWifiProvision,
  shouldSendAuthProvision,
  shouldSendLegacyRearm,
  sendWifiProvisionToAll,
  sendAuthProvisionToAll,
  sendLegacyRearmProvision,
  __setConnectionsForTest,
  esp32DeviceInfoRow,
  shouldRetryDeviceInfoIdentify,
  isSerialReachableForDedup,
  recordForeignProbeFailure,
  isForeignPortDenylisted,
  __resetForeignPortState,
  sendEventToBoard,
  setSerialCommandSink,
  setSerialTimelineQueryHandler,
  type SerialConnection,
} from '../esp32-serial.js';
import { boardTimelineSeed } from '../board-timeline-entry.js';
import { buildWifiProvision } from '../esp32-wifi-cred.js';
import { wireSessionTimelineReplies } from '../session-timeline-reply.js';
import { resolveSessionIdPrefix } from '../session-id-resolve.js';

describe('CI waiting evidence projection', () => {
  it('serializes the same pending/terminal evidence as the full waitingOn policy', () => {
    for (const vector of ciProjection) {
      const frame = prepareForSerial({ type: 'sessions_list', sessions: [{
        id: 'evidence-session', alive: true, state: 'idle', agentType: 'codex-cli',
        projectName: 'fixture', port: 0, waitingOn: vector.wait,
      }] } as never);
      const wire = JSON.parse(JSON.stringify(frame));
      expect(wire.sessions[0].ciPhase).toBe(vector.expected);
    }
  });
});

describe('background task compact transport', () => {
  it('preserves explicit zero and bounded counts without manufacturing a count', () => {
    for (const count of [undefined, null, 0, 7, 4096, -1, 4097, 1.5, true]) {
      const frame = prepareForSerial({type:'sessions_list',sessions:[{
        id:'background-owner',alive:true,state:'processing',agentType:'codex-cli',
        projectName:'fixture',port:0,backgroundTaskCount:count,
      }]} as never);
      const row=JSON.parse(JSON.stringify(frame)).sessions[0];
      if (typeof count === 'number' && Number.isInteger(count) && count >= 0 && count <= 4096)
        expect(row.backgroundTaskCount).toBe(count);
      else expect(row).not.toHaveProperty('backgroundTaskCount');
    }
  });
});

// ─── Event filtering ────────────────────────────────────────────────

describe('SERIAL_FORWARDED_EVENTS', () => {
  it('includes all display events', () => {
    for (const evt of DISPLAY_FORWARDED_EVENTS) {
      expect(SERIAL_FORWARDED_EVENTS.has(evt)).toBe(true);
    }
  });

  it('includes timeline events (unique to serial)', () => {
    expect(SERIAL_FORWARDED_EVENTS.has('timeline_event')).toBe(true);
    expect(SERIAL_FORWARDED_EVENTS.has('timeline_history')).toBe(true);
  });

  it('does NOT include plugin-only events', () => {
    expect(SERIAL_FORWARDED_EVENTS.has('encoder_state')).toBe(false);
    expect(SERIAL_FORWARDED_EVENTS.has('button_state')).toBe(false);
    expect(SERIAL_FORWARDED_EVENTS.has('deck_slot_map')).toBe(false);
    expect(SERIAL_FORWARDED_EVENTS.has('voice_state')).toBe(false);
    expect(SERIAL_FORWARDED_EVENTS.has('prompt_options')).toBe(false);
    expect(SERIAL_FORWARDED_EVENTS.has('user_prompt')).toBe(false);
  });

  it('required serial events are present', () => {
    const required = ['state_update', 'usage_update', 'sessions_list', 'connection', 'display_state'];
    for (const evt of required) {
      expect(SERIAL_FORWARDED_EVENTS.has(evt)).toBe(true);
    }
  });
});

// ─── Port detection patterns (from source) ──────────────────────────

describe('ESP32 port detection patterns', () => {
  function matchesESP32(port: string): boolean {
    if (EXCLUDE_PATTERNS.some(p => p.test(port))) return false;
    return ESP32_PORT_PATTERNS.some(p => p.test(port));
  }

  it('matches CH340 ports (86 Box)', () => {
    expect(matchesESP32('/dev/cu.usbserial-21130')).toBe(true);
    expect(matchesESP32('/dev/cu.usbserial-1420')).toBe(true);
  });

  it('matches native USB JTAG ports (IPS 3.5", Round AMOLED)', () => {
    expect(matchesESP32('/dev/cu.usbmodem2111101')).toBe(true);
    expect(matchesESP32('/dev/cu.usbmodem211201')).toBe(true);
  });

  it('matches Linux serial ports', () => {
    expect(matchesESP32('/dev/ttyUSB0')).toBe(true);
    expect(matchesESP32('/dev/ttyACM0')).toBe(true);
  });

  it('excludes Bluetooth and WLAN', () => {
    expect(matchesESP32('/dev/cu.Bluetooth-Incoming-Port')).toBe(false);
    expect(matchesESP32('/dev/cu.WLAN-Module')).toBe(false);
  });

  it('excludes non-ESP32 ports', () => {
    expect(matchesESP32('/dev/cu.serial')).toBe(false);
    expect(matchesESP32('/dev/tty.usbserial-1')).toBe(false);
  });
});

// ─── Serial line parsing (actual source function) ───────────────────

describe('handleSerialLine (source)', () => {
  /** Create a minimal mock SerialConnection for testing handleSerialLine */
  function mockConn(): SerialConnection & { captured: Array<{ port: string; msg: unknown }> } {
    const captured: Array<{ port: string; msg: unknown }> = [];
    return {
      port: '/dev/cu.usbserial-test',
      fd: null,
      stream: { destroyed: false, writable: true, write: () => true } as any,
      reader: null,
      readBuf: '',
      connected: true,
      deviceInfo: null,
      deviceInfoFresh: false,
      provisionSent: false,
      connectedAt: Date.now(),
      lastReadAt: Date.now(),
      lastWriteAt: Date.now(),
      lastDeviceInfoRequestAt: 0,
      deviceInfoRequestsSent: 0,
      writeQueue: [],
      writeTimer: null,
      captured,
    };
  }

  it('parses device_info message and updates deviceInfo', () => {
    const conn = mockConn();
    handleSerialLine(conn, '{"type":"device_info","board":"trmnl_75","version":"1.0.0","wifiConfigured":false,"wifiConnected":false,"repaintCount":2757,"fullRefreshCount":461,"usageCodex5H":-1,"usageCodex7D":37}');

    expect(conn.deviceInfo).not.toBeNull();
    expect(conn.deviceInfo!.board).toBe('trmnl_75');
    expect(conn.deviceInfo!.version).toBe('1.0.0');
    expect(conn.deviceInfo!.repaintCount).toBe(2757);
    expect(conn.deviceInfo!.fullRefreshCount).toBe(461);
    expect(conn.deviceInfo!.usageCodex5H).toBe(-1);
    expect(conn.deviceInfo!.usageCodex7D).toBe(37);
  });

  it('carries the allocation-failure counter, including an explicit zero', () => {
    const conn = mockConn();
    handleSerialLine(conn, '{"type":"device_info","board":"ips_35","version":"1.9.2","wifiConfigured":true,"wifiConnected":false,"minFreeHeapKb":0,"allocFailures":0}');
    expect(conn.deviceInfo!.minFreeHeapKb).toBe(0);
    expect(conn.deviceInfo!.allocFailures).toBe(0);
    expect(conn.deviceInfo!.allocFailLastBytes).toBeUndefined();
    handleSerialLine(conn, '{"type":"device_info","board":"ips_35","version":"1.9.2","wifiConfigured":true,"wifiConnected":false,"allocFailures":3,"allocFailLastBytes":1664,"allocFailLastCaps":2052}');
    expect(conn.deviceInfo!.allocFailures).toBe(3);
    expect(conn.deviceInfo!.allocFailLastBytes).toBe(1664);
    expect(conn.deviceInfo!.allocFailLastCaps).toBe(2052);
  });

  it('carries the board-reported WiFi RSSI and drops implausible values', () => {
    const conn = mockConn();
    handleSerialLine(conn, '{"type":"device_info","board":"round_amoled","version":"1.4.0","wifiConfigured":true,"wifiConnected":true,"ip":"192.168.68.55","rssiDbm":-78}');
    expect(conn.deviceInfo!.rssiDbm).toBe(-78);
    handleSerialLine(conn, '{"type":"device_info","board":"round_amoled","version":"1.4.0","wifiConfigured":true,"wifiConnected":true,"rssiDbm":0}');
    expect(conn.deviceInfo!.rssiDbm).toBeUndefined();
  });

  it('carries the WiFi credential id only as a string', () => {
    const conn = mockConn();
    handleSerialLine(conn, '{"type":"device_info","board":"t_embed","version":"1.9.3","wifiConfigured":false,"wifiConnected":false,"wifiRadioParked":true,"wifiCredId":"4fbb066b2801b4ae"}');
    expect(conn.deviceInfo!.wifiCredId).toBe('4fbb066b2801b4ae');
    handleSerialLine(conn, '{"type":"device_info","board":"t_embed","version":"1.9.3","wifiConfigured":false,"wifiConnected":false,"wifiCredId":""}');
    expect(conn.deviceInfo!.wifiCredId).toBe('');
    // Older firmware never sends the key: no information, not "none stored".
    handleSerialLine(conn, '{"type":"device_info","board":"t_embed","version":"1.9.2","wifiConfigured":false,"wifiConnected":false}');
    expect(conn.deviceInfo!.wifiCredId).toBeUndefined();
    handleSerialLine(conn, '{"type":"device_info","board":"t_embed","version":"1.9.3","wifiConfigured":false,"wifiConnected":false,"wifiCredId":42}');
    expect(conn.deviceInfo!.wifiCredId).toBeUndefined();
  });

  it('keeps the credential id off /devices and out of the device cache', () => {
    const conn = mockConn();
    conn.port = '/dev/cu.usbserial-credid';
    handleSerialLine(conn, '{"type":"device_info","board":"t_embed","version":"1.9.3","wifiConfigured":false,"wifiConnected":false,"wifiRadioParked":true,"wifiCredId":"4fbb066b2801b4ae"}');
    // The live connection keeps it: it decides provisioning.
    expect(conn.deviceInfo!.wifiCredId).toBe('4fbb066b2801b4ae');
    const row = esp32DeviceInfoRow(conn, Date.now());
    expect(row.board).toBe('t_embed');
    expect(row.wifiRadioParked).toBe(true);
    expect(row).not.toHaveProperty('wifiCredId');
    const cache = JSON.parse(readFileSync(join(process.env.AGENTDECK_DATA_DIR!, 'esp32-device-cache.json'), 'utf-8'));
    expect(cache[conn.port]?.board).toBe('t_embed');
    expect(cache[conn.port]).not.toHaveProperty('wifiCredId');
  });

  it('skips debug lines (non-JSON)', () => {
    const conn = mockConn();
    handleSerialLine(conn, '[WiFi] Connected to network');
    handleSerialLine(conn, 'Boot OK!');
    handleSerialLine(conn, 'E (1234) task_wdt: Task watchdog');
    handleSerialLine(conn, '');

    expect(conn.deviceInfo).toBeNull(); // Nothing parsed
  });

  it('retains numeric e-ink completion events without painted content', () => {
    const log = vi.spyOn(logger, 'logTagged').mockImplementation(() => {});
    try {
      const conn = mockConn();
      const event = '[EinkRefresh] count=12 full=1 startedMs=123456 durationMs=3500';
      handleSerialLine(conn, event);
      handleSerialLine(conn, event + ' private painted text');
      handleSerialLine(conn, '[EinkRefresh] count=12 full=2 startedMs=1 durationMs=3');
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith('esp32-eink', `${conn.port}: ${event}`);
    } finally {
      log.mockRestore();
    }
  });

  it('retains numeric heap-failure lines and nothing appended to them', () => {
    const log = vi.spyOn(logger, 'logTagged').mockImplementation(() => {});
    try {
      const conn = mockConn();
      const event = '[HeapFail] count=2 lastBytes=1664 lastCaps=0x804 internalFree=1180 internalMin=0 internalLargest=1024';
      handleSerialLine(conn, event);
      handleSerialLine(conn, event + ' ssid=private');
      handleSerialLine(conn, '[HeapFail] count=2 lastBytes=1664 lastCaps=0xZZ internalFree=1 internalMin=0 internalLargest=1');
      handleSerialLine(conn, '[HeapFail] count=-1 lastBytes=1664 lastCaps=0x804 internalFree=1 internalMin=0 internalLargest=1');
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith('esp32-heap', `${conn.port}: ${event}`);
      expect(conn.panicLogUntil).toBeUndefined();
    } finally {
      log.mockRestore();
    }
  });

  it('retains numeric internal-reserve lines and nothing appended to them', () => {
    const log = vi.spyOn(logger, 'logTagged').mockImplementation(() => {});
    try {
      const conn = mockConn();
      const boot = '[Reserve] at=boot capacity=15360 regions=1 requested=16384';
      const heapFail = '[Reserve] at=heap-fail capacity=15360 free=14336 min=9216 allocFailures=1';
      const otaEnd = '[Reserve] at=ota-end capacity=15360 free=15360 min=9216 allocFailures=1';
      handleSerialLine(conn, boot);
      handleSerialLine(conn, heapFail);
      handleSerialLine(conn, otaEnd);
      handleSerialLine(conn, otaEnd + ' ssid=private');
      handleSerialLine(conn, '[Reserve] at=boot capacity=lots');
      handleSerialLine(conn, '[Reserve] internal pool 15360 B usable');
      expect(log).toHaveBeenCalledTimes(3);
      expect(log).toHaveBeenNthCalledWith(1, 'esp32-heap', `${conn.port}: ${boot}`);
      expect(log).toHaveBeenNthCalledWith(2, 'esp32-heap', `${conn.port}: ${heapFail}`);
      expect(log).toHaveBeenNthCalledWith(3, 'esp32-heap', `${conn.port}: ${otaEnd}`);
    } finally {
      log.mockRestore();
    }
  });

  it('retains hosted software-reset evidence without logging subsequent private lines', () => {
    const log = vi.spyOn(logger, 'logTagged').mockImplementation(() => {});
    try {
      const conn = mockConn();
      const failure = 'E (354179) H_SDIO_DRV: sdio_write_task: 0: Failed to send data: 258 1502 1502';
      handleSerialLine(conn, '\x1b[0;31m' + failure + '\x1b[0m');
      handleSerialLine(conn, 'E (354182) H_SDIO_DRV: Unrecoverable host sdio state');
      handleSerialLine(conn, '[SdioTx] staged=1 bytes=1536 result=0');
      handleSerialLine(conn, 'E (43) H_SDIO_DRV: private packet contents');
      handleSerialLine(conn, '[SdioTx] staged=1 bytes=1536 result=0 token=secret');
      handleSerialLine(conn, '[Voice] transcript: private speech');
      expect(log).toHaveBeenCalledTimes(3);
      expect(log).toHaveBeenCalledWith('esp32-transport', `${conn.port}: ${failure}`);
      expect(conn.panicLogUntil).toBeUndefined();
    } finally { log.mockRestore(); }
  });

  it('records allowed voice stages under normal serial ownership', () => {
    const log = vi.spyOn(logger, 'logTagged').mockImplementation(() => {});
    try {
      const conn = mockConn();
      handleSerialLine(conn, '[Voice] HTTP upload 85824 bytes -> 200 (attempt 1)');
      handleSerialLine(conn, '[Voice] transcript: private speech');
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith('esp32-voice',
        `${conn.port}: [Voice] HTTP upload 85824 bytes -> 200 (attempt 1)`);
    } finally {
      log.mockRestore();
    }
  });

  it('does not misclassify the normal I2C register probe as a panic', () => {
    const conn = mockConn();
    expect(capturePanicLine(conn, '[I2CDiag] --- register dump 0x18 (read-only) ---')).toBe(false);
    expect(conn.panicLogUntil).toBeUndefined();
    expect(capturePanicLine(conn, 'Core  0 register dump:')).toBe(true);
  });

  it.each([
    '[WakeVoice] detected score=242',
    '[WakeVoice] capture end samples=42912 queued=1',
    '[Voice] HTTP upload attempt 1: 85824 bytes, internal heap 84 KB',
    '[Voice] HTTP upload 85824 bytes -> 200 (attempt 1)',
    '[Voice] HTTP upload 85824 bytes -> -2 (attempt 1)',
    '[VoicePerf] uploadMs=198 minInternalKB=59 pressureWaits=2',
    '[Speaker] played 28132/28132 bytes (0.9s), 0 frames dropped',
    '[VoiceFeedback] state=waiting captureElapsedMs=0',
    '[VoiceEndpoint] complete elapsedMs=2422 quietMs=1217 rms=99 threshold=209',
  ])('retains a content-free voice milestone: %s', line => {
    expect(isVoiceDiagnosticLine(line)).toBe(true);
  });

  it.each([
    '[Voice] upload peer=192.168.68.100:9120',
    '[WakeVoice] capture wake target=private-session noise=88 threshold=209',
    '[VoiceFeedback] state=waiting captureElapsedMs=0 secret text',
    '[Voice] transcript: private speech',
    '{"type":"voice_result","text":"private speech"}',
    '[Voice] ' + 'x'.repeat(500),
  ])('does not log unapproved voice content: %s', line => {
    expect(isVoiceDiagnosticLine(line)).toBe(false);
  });

  it('opens a panic capture window on crash markers and captures the dump', () => {
    const conn = mockConn();
    // Ordinary chatter before a crash is not captured
    expect(capturePanicLine(conn, '[WiFi] Connected to network')).toBe(false);

    // Marker opens the window; subsequent register-dump lines are captured
    expect(capturePanicLine(conn, "Guru Meditation Error: Core  1 panic'ed (LoadProhibited). Exception was unhandled.")).toBe(true);
    expect(capturePanicLine(conn, 'Core  1 register dump:')).toBe(true);
    expect(capturePanicLine(conn, 'PC      : 0x42012345  PS      : 0x00060030')).toBe(true);
    expect(capturePanicLine(conn, 'Backtrace: 0x42012345:0x3fc9e0 0x42011111:0x3fca00')).toBe(true);
    expect(capturePanicLine(conn, 'Rebooting...')).toBe(true);

    // handleSerialLine routes non-JSON lines into the capture window
    handleSerialLine(conn, 'rst:0x3 (RTC_SW_SYS_RST),boot:0x8 (SPI_FAST_FLASH_BOOT)');
    expect(conn.panicLogLines).toBe(6);
  });

  it('closes the panic window after expiry and caps captured lines', () => {
    const conn = mockConn();
    conn.panicLogUntil = Date.now() - 1;
    expect(capturePanicLine(conn, 'PC      : 0x42012345')).toBe(false);

    conn.panicLogUntil = Date.now() + 10_000;
    conn.panicLogLines = 200;
    expect(capturePanicLine(conn, 'PC      : 0x42012345')).toBe(false);
  });

  it('recovers from malformed JSON', () => {
    const conn = mockConn();
    handleSerialLine(conn, '{not valid json}');
    handleSerialLine(conn, '{"type":"device_info","board":');

    expect(conn.deviceInfo).toBeNull(); // Bad JSON ignored

    // Next valid message should still parse
    handleSerialLine(conn, '{"type":"device_info","board":"86box","version":"1.0","wifiConfigured":false,"wifiConnected":false}');
    expect(conn.deviceInfo).not.toBeNull();
    expect(conn.deviceInfo!.board).toBe('86box');
  });

  it('ignores JSON without type field', () => {
    const conn = mockConn();
    handleSerialLine(conn, '{"board":"86box"}');
    handleSerialLine(conn, '{"foo":"bar"}');

    expect(conn.deviceInfo).toBeNull();
  });

  it('does not mark deviceInfo present for non-identifying messages', () => {
    const conn = mockConn();
    handleSerialLine(conn, '{"type":"heartbeat_ack"}');
    handleSerialLine(conn, '{"type":"wifi_provision_ack","success":true,"ip":"192.168.68.70"}');

    expect(conn.deviceInfo).toBeNull();
  });
});

describe('budgetTimelineEntries', () => {
  it('keeps the newest entries under the byte budget, in chronological order', () => {
    // ~330B of CJK per stamped entry → 64 rows ≈ 21KB unbudgeted
    const entries = Array.from({ length: 64 }, (_, i) => ({
      ts: i, raw: `${i}-${'가'.repeat(80)}`, localHm: '12:00',
    }));
    const kept = budgetTimelineEntries(entries);
    expect(kept.length).toBeLessThan(entries.length);
    expect(kept.length).toBeGreaterThan(0);
    const total = kept.reduce((n, e) => n + new TextEncoder().encode(JSON.stringify(e)).length + 1, 0);
    expect(total).toBeLessThanOrEqual(TIMELINE_HISTORY_BYTE_BUDGET);
    // Newest survive; order stays chronological
    expect(kept[kept.length - 1].ts).toBe(63);
    expect(kept.every((e, i) => i === 0 || e.ts > kept[i - 1].ts)).toBe(true);
  });

  it('passes small histories through untouched', () => {
    const entries = [{ ts: 1, raw: 'a' }, { ts: 2, raw: 'b' }];
    expect(budgetTimelineEntries(entries)).toEqual(entries);
  });
});

describe('serial I/O error classification', () => {
  it('treats nonblocking backpressure as retryable', () => {
    expect(isRetryableSerialIoError(Object.assign(new Error('again'), { code: 'EAGAIN' }))).toBe(true);
    expect(isRetryableSerialIoError(Object.assign(new Error('would block'), { code: 'EWOULDBLOCK' }))).toBe(true);
  });

  it('does not retry terminal serial errors', () => {
    expect(isRetryableSerialIoError(Object.assign(new Error('gone'), { code: 'ENXIO' }))).toBe(false);
    expect(isRetryableSerialIoError(new Error('plain'))).toBe(false);
  });
});

// ─── Payload preparation (actual source function) ───────────────────

describe('prepareForSerial (source)', () => {
  it('strips agentCapabilities from state_update', () => {
    const event: StateUpdateEvent = {
      type: 'state_update',
      state: State.IDLE,
      permissionMode: PermissionMode.DEFAULT,
      agentCapabilities: {
        type: 'claude-code',
        displayName: 'Claude Code',
        hasTerminal: true,
        hasModeSwitching: true,
        hasDiffReview: true,
        hasOptionLists: true,
        hasNavigablePrompts: true,
        hasSuggestedPrompts: true,
        hasApiUsage: true,
        hasModelCatalog: false,
      },
    };

    const prepared = prepareForSerial(event) as unknown as Record<string, unknown>;
    expect(prepared.agentCapabilities).toBeUndefined();
    expect(prepared.type).toBe('state_update');
    expect(prepared.state).toBe(State.IDLE);
  });

  it('strips billingType and remoteUrl from state_update', () => {
    const event: StateUpdateEvent = {
      type: 'state_update',
      state: State.PROCESSING,
      permissionMode: PermissionMode.DEFAULT,
      billingType: 'subscription',
      remoteUrl: 'https://example.com',
    };

    const prepared = prepareForSerial(event) as unknown as Record<string, unknown>;
    expect(prepared.billingType).toBeUndefined();
    expect(prepared.remoteUrl).toBeUndefined();
  });

  it('preserves essential state_update fields', () => {
    const event: StateUpdateEvent = {
      type: 'state_update',
      state: State.AWAITING_PERMISSION,
      permissionMode: PermissionMode.PLAN,
      agentType: 'claude-code',
      currentTool: 'Edit',
      projectName: 'AgentDeck',
      modelName: 'opus-4',
      focusedSessionId: 'observed:claude:abcdefghijklmnopqrstuvwxyz',
      options: [{ index: 0, label: 'Allow', shortcut: 'y' }],
      question: 'Allow Edit?',
      gatewayAvailable: true,
    };

    const prepared = prepareForSerial(event) as unknown as Record<string, unknown>;
    expect(prepared.state).toBe(State.AWAITING_PERMISSION);
    expect(prepared.agentType).toBe('claude-code');
    expect(prepared.currentTool).toBe('Edit');
    expect(prepared.projectName).toBe('AgentDeck');
    expect(prepared.modelName).toBe('opus-4');
    expect(prepared.focusedSessionId).toBe('observed:claude:abcdefghijklmno');
    expect((prepared.options as unknown[])).toHaveLength(1);
    expect(prepared.gatewayAvailable).toBe(true);
  });

  it('strips bulky state_update fields before device_info arrives', () => {
    const event = {
      type: 'state_update',
      state: State.IDLE,
      permissionMode: PermissionMode.DEFAULT,
      moduleHealth: { serial: { available: true } },
      subscriptions: [{ name: 'Claude' }],
      voiceAssistantState: 'listening',
      voiceAssistantText: 'hello',
      voiceAssistantResponseText: 'world',
      pairingUrl: 'https://example.com/pair',
      gatewayDeviceId: 'abc',
      gatewayAuthRequestId: 'req',
      gatewayAuthMessage: 'msg',
      remoteUrl: 'wss://example.com',
      modelCatalog: [{ name: 'GLM-5.1', available: true }],
      sessionStatus: { contextTokens: 12345 },
    } as any as StateUpdateEvent;

    const prepared = prepareForSerial(event, { deviceInfo: null }) as unknown as Record<string, unknown>;
    expect(prepared.moduleHealth).toBeUndefined();
    expect(prepared.subscriptions).toBeUndefined();
    expect(prepared.voiceAssistantState).toBeUndefined();
    expect(prepared.voiceAssistantText).toBeUndefined();
    expect(prepared.voiceAssistantResponseText).toBeUndefined();
    expect(prepared.pairingUrl).toBeUndefined();
    expect(prepared.gatewayDeviceId).toBeUndefined();
    expect(prepared.gatewayAuthRequestId).toBeUndefined();
    expect(prepared.gatewayAuthMessage).toBeUndefined();
    expect(prepared.remoteUrl).toBeUndefined();
    expect(prepared.modelCatalog).toBeUndefined();
    expect(prepared.sessionStatus).toBeUndefined();
  });

  it('trims sessions_list to firmware fields and string sizes', () => {
    const prepared = prepareForSerial({
      type: 'sessions_list',
      sessions: [{
        id: 's'.repeat(80),
        projectName: 'p'.repeat(80),
        modelName: 'm'.repeat(80),
        agentType: 'claude-code',
        state: 'processing',
        port: 9122,
        alive: true,
        extra: 'not-for-firmware',
      }],
    } as any) as any;

    expect(prepared.sessions).toHaveLength(1);
    expect(prepared.sessions[0].id).toHaveLength(31);
    expect(prepared.sessions[0].projectName).toHaveLength(39);
    expect(prepared.sessions[0].modelName).toHaveLength(31);
    expect(prepared.sessions[0].extra).toBeUndefined();
  });

  it('forwards per-session D1 mosaic fields (tool/elapsed/awaiting prompt) and trims oversized strings', () => {
    const prepared = prepareForSerial({
      type: 'sessions_list',
      sessions: [{
        id: 's1', projectName: 'AgentDeck', modelName: 'opus-4-6',
        agentType: 'claude-code', state: 'awaiting_permission', port: 9122, alive: true,
        currentTool: 'Write · ' + 'x'.repeat(80),
        question: 'q'.repeat(200),
        promptType: 'yes_no',
        elapsedSec: 1083.7,
        options: Array.from({ length: 12 }, (_, i) => ({ label: 'L'.repeat(120), index: i, recommended: i === 0 })),
        extra: 'not-for-firmware',
      }],
    } as any) as any;

    const s = prepared.sessions[0];
    // Caps are UTF-8 BYTE budgets (firmware buffers are byte-sized): the "·"
    // in the tool name weighs 2 bytes, so 39 bytes = 38 characters here.
    expect(new TextEncoder().encode(s.currentTool).length).toBeLessThanOrEqual(39);
    expect(s.currentTool).toBe('Write · ' + 'x'.repeat(30));
    expect(s.question).toHaveLength(159);
    expect(s.requestId).toBeUndefined(); // observed gate removed — no requestId passthrough
    expect(s.promptType).toBe('yes_no');
    expect(s.elapsedSec).toBe(1084); // rounded
    expect(s.options).toHaveLength(8); // sanitizeOptions caps at 8
    expect(s.options[0].label).toHaveLength(79);
    expect(s.extra).toBeUndefined();
  });

  it('round-robins sessions_list by agent type so non-Claude agents survive the cap', () => {
    // More alive Claude sessions than the cap, ahead of Codex + OpenClaw — the
    // real-world layout that a plain slice(0, cap) would drop the tail of.
    const sessions = [
      ...Array.from({ length: 11 }, (_, i) => ({
        id: `cc-${i}`, agentType: 'claude-code', state: 'idle', alive: true, port: 9120 + i,
      })),
      { id: 'cc-busy', agentType: 'claude-code', state: 'processing', alive: true, port: 9140 },
      { id: 'cx', agentType: 'codex-cli', state: 'idle', alive: true, port: 9150 },
      { id: 'oc', agentType: 'openclaw', state: 'processing', alive: true, port: 18789 },
    ];

    const prepared = prepareForSerial({ type: 'sessions_list', sessions } as any) as any;
    const ids = prepared.sessions.map((s: any) => s.id);

    expect(prepared.sessions).toHaveLength(SERIAL_SESSIONS_CAP);
    expect(ids).toContain('cx'); // Codex no longer starved out
    expect(ids).toContain('oc'); // OpenClaw too
    // Active Claude is preferred over its idle siblings within the type.
    expect(ids).toContain('cc-busy');
  });

  it('roundRobinByAgentType keeps every present agent type and is a no-op under the cap', () => {
    const under = [
      { agentType: 'claude-code', alive: true, state: 'idle' },
      { agentType: 'codex-cli', alive: true, state: 'idle' },
    ];
    expect(roundRobinByAgentType(under, SERIAL_SESSIONS_CAP)).toEqual(under);

    const many = [
      ...Array.from({ length: 8 }, () => ({ agentType: 'claude-code', alive: true, state: 'idle' })),
      { agentType: 'codex-cli', alive: true, state: 'idle' },
      { agentType: 'openclaw', alive: true, state: 'processing' },
      { agentType: 'opencode', alive: true, state: 'idle' },
    ];
    const picked = roundRobinByAgentType(many, SERIAL_SESSIONS_CAP);
    const types = new Set(picked.map((s) => s.agentType));
    expect(picked).toHaveLength(SERIAL_SESSIONS_CAP);
    expect(types).toContain('codex-cli');
    expect(types).toContain('openclaw');
    expect(types).toContain('opencode');
  });

  it('strips legacy usage fields from usage_update', () => {
    const event: UsageEvent = {
      type: 'usage_update',
      sessionDurationSec: 300,
      inputTokens: 5000,
      outputTokens: 2000,
      toolCalls: 10,
      sessionPercent: 42,
      costSpent: 1.5,
      costLimit: 10.0,
      resetTime: '13:00',
      resetDate: '2026-03-21',
      ollamaStatus: { available: true, models: [] },
      tokenStatus: 'valid',
    };

    const prepared = prepareForSerial(event) as unknown as Record<string, unknown>;
    expect(prepared.sessionPercent).toBeUndefined();
    expect(prepared.costSpent).toBeUndefined();
    expect(prepared.costLimit).toBeUndefined();
    expect(prepared.resetTime).toBeUndefined();
    expect(prepared.resetDate).toBeUndefined();
    expect(prepared.ollamaStatus).toBeUndefined();
    expect(prepared.tokenStatus).toBeUndefined();

    expect(prepared.sessionDurationSec).toBe(300);
    expect(prepared.inputTokens).toBe(5000);
    expect(prepared.outputTokens).toBe(2000);
    expect(prepared.toolCalls).toBe(10);
  });

  it('preserves Codex window freshness for firmware-side hiding', () => {
    const event: UsageEvent = {
      type: 'usage_update', sessionDurationSec: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0,
      codexRateLimits: {
        primary: { usedPercent: 62, windowMinutes: 300, stale: true },
        secondary: { usedPercent: 31, windowMinutes: 10080, stale: false },
      },
    };
    const prepared = prepareForSerial(event) as any;
    expect(prepared.codexRateLimits.primary).toMatchObject({ usedPercent: 62, stale: true });
    expect(prepared.codexRateLimits.secondary).toMatchObject({ usedPercent: 31, stale: false });
  });

  it('forwards z.ai windowMinutes so serial boards label windows by length, not "P"/"S"', () => {
    // The firmware's windowLabel prints the reported length ("5H"/"7D") and
    // falls back to the generic "P"/"S" when windowMinutes is absent — the
    // serial whitelist once dropped it and a TC001 read "P 1%" instead of
    // "5H 1%" while the WiFi (unshrunk) path was fine.
    const event: UsageEvent = {
      type: 'usage_update', sessionDurationSec: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0,
      zaiRateLimits: {
        primary: { usedPercent: 1, windowMinutes: 300 },
        secondary: { usedPercent: 43, windowMinutes: 10080, quantity: 'tokens' },
      },
    };
    const prepared = prepareForSerial(event) as any;
    expect(prepared.zaiRateLimits.primary).toMatchObject({ usedPercent: 1, windowMinutes: 300 });
    expect(prepared.zaiRateLimits.secondary).toMatchObject({ usedPercent: 43, windowMinutes: 10080, quantity: 'tokens' });
  });

  it('passes through other events unchanged', () => {
    const event: BridgeEvent = {
      type: 'connection',
      status: 'connected',
      sessionId: 'abc',
    };

    const prepared = prepareForSerial(event);
    expect(prepared).toEqual(event);
  });

  it('caps timeline raw by UTF-8 BYTES on a code-point boundary (한글-safe)', () => {
    // 60 한글 syllables = 180 UTF-8 bytes but only 60 UTF-16 units — a length
    // cap would pass it through and the firmware's 119-byte strncpy would cut
    // mid-glyph. The cap must be bytes, and must never split a code point.
    const raw = '가'.repeat(60);
    const prepared = prepareForSerial({
      type: 'timeline_event',
      entry: { ts: 1752700000000, type: 'chat_start', raw, projectName: '프로젝트'.repeat(20) },
    } as any) as any;
    const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;
    const outRaw: string = prepared.entry.raw;
    expect(utf8Bytes(outRaw)).toBeLessThanOrEqual(119);
    expect(outRaw).toBe('가'.repeat(39));           // 39 × 3 bytes = 117 ≤ 119, whole glyphs only
    expect(utf8Bytes(prepared.entry.projectName)).toBeLessThanOrEqual(39);

    // ASCII behaviour is unchanged: 119 bytes == 119 chars.
    const ascii = 'x'.repeat(200);
    const p2 = prepareForSerial({
      type: 'timeline_event',
      entry: { ts: 1752700000000, type: 'chat_start', raw: ascii },
    } as any) as any;
    expect(p2.entry.raw).toBe('x'.repeat(119));
  });

  it('forwards daemon-computed lastEvent* fields byte-capped, omitted when absent', () => {
    const prepared = prepareForSerial({
      type: 'sessions_list',
      sessions: [
        { id: 's1', alive: true, lastEventText: '가'.repeat(60), lastEventTask: 'ips10 카드 개선', lastEventHm: '14:07' },
        { id: 's2', alive: true },
      ],
    } as any) as any;
    const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;
    const [withEvent, without] = prepared.sessions;
    expect(utf8Bytes(withEvent.lastEventText)).toBeLessThanOrEqual(99);
    expect(withEvent.lastEventTask).toBe('ips10 카드 개선');
    expect(withEvent.lastEventHm).toBe('14:07');
    expect(without.lastEventText).toBeUndefined();   // omitted, not empty string
    expect(without.lastEventTask).toBeUndefined();
    expect(without.lastEventHm).toBeUndefined();
  });

  it('caps timeline_history to the firmware ring (64) AND the line-buffer byte budget', () => {
    const entries = Array.from({ length: 100 }, (_, i) => ({
      ts: 1752700000000 + i, type: 'chat_start', raw: `row ${i}`,
    }));
    const prepared = prepareForSerial({ type: 'timeline_history', entries } as any) as any;
    // Newest-first byte budget: never more than the 64-row ring, and the
    // summed frame always fits TIMELINE_HISTORY_BYTE_BUDGET.
    expect(prepared.entries.length).toBeLessThanOrEqual(64);
    const total = prepared.entries.reduce(
      (n: number, e: unknown) => n + new TextEncoder().encode(JSON.stringify(e)).length + 1, 0);
    expect(total).toBeLessThanOrEqual(TIMELINE_HISTORY_BYTE_BUDGET);
    // Newest survive, chronological order preserved
    expect(prepared.entries[prepared.entries.length - 1].raw).toBe('row 99');
    expect(prepared.entries[0].ts).toBeLessThan(prepared.entries[1].ts);
  });
});

// ─── Claude tool rows ───────────────────────────────────────────────
// Per-tool hook rows (`toolEvent`) go only to clients that offer
// `timeline.tool-events.read`, and a board offers nothing. The WiFi transformer
// always dropped them; serial sent every one, so a board's 64-row ring filled
// with them on USB and not on WiFi.

describe('Claude tool rows on the serial path', () => {
  const chat = (i: number) => ({ ts: 1752700000000 + i, type: 'chat_start', raw: `row ${i}` });
  const tool = (i: number) => ({ ts: 1752700000000 + i, type: 'tool_request', raw: 'Read requested', toolEvent: true });
  // A pending flush timer keeps sendToConnection from scheduling a real write,
  // so the queue is what the board would be sent.
  const queueConn = () => ({
    port: '/dev/cu.usbmodem-test', connected: true, deviceInfo: { board: 't_embed' },
    writeQueue: [] as string[], writeTimer: {} as ReturnType<typeof setTimeout>,
  }) as unknown as SerialConnection;

  it('drops a live tool row and still sends every other timeline row', () => {
    const conn = queueConn();
    sendEventToBoard(conn, { type: 'timeline_event', entry: tool(1) } as any);
    expect(conn.writeQueue).toEqual([]);
    sendEventToBoard(conn, { type: 'timeline_event', entry: chat(2) } as any);
    // The flag decides, not the type: a tool_request without it (an approval
    // row) is a turn-level row every client reads.
    sendEventToBoard(conn, { type: 'timeline_event', entry: { ...chat(3), type: 'tool_request', raw: 'Bash' } } as any);
    expect(conn.writeQueue.map((line) => JSON.parse(line).entry.raw)).toEqual(['row 2', 'Bash']);
  });

  it('ships a history frame with tool rows exactly as it ships one without them', () => {
    // Cut to the 64-row ring first, these 104 rows would keep only rows
    // 40–63 and lose the rest to tool rows the board must not get anyway.
    const chats = Array.from({ length: 64 }, (_, i) => chat(i));
    const entries = [...chats, ...Array.from({ length: 40 }, (_, i) => tool(100 + i))];
    const prepared = prepareForSerial({ type: 'timeline_history', entries } as any) as any;
    expect(prepared).toEqual(prepareForSerial({ type: 'timeline_history', entries: chats } as any));
    expect(prepared.entries.length).toBeGreaterThan(24);
    expect(prepared.entries[prepared.entries.length - 1].raw).toBe('row 63');
  });

  it('seeds a connecting board with the newest rows it may show', () => {
    const history = [chat(1), chat(2), tool(3), chat(4), tool(5), tool(6), tool(7), tool(8), tool(9), tool(10)];
    expect(boardTimelineSeed(history, 3).map((entry) => entry.raw)).toEqual(['row 1', 'row 2', 'row 4']);
  });
});

describe('query_session_timeline over serial', () => {
  // A pending flush timer keeps sendToConnection from scheduling a real write,
  // so the queue is what the board would be sent.
  const queueConn = () => ({
    port: '/dev/cu.usbmodem-knob', connected: true, deviceInfo: { board: 't_embed' }, deviceInfoFresh: true,
    lastReadAt: 0, writeQueue: [] as string[], writeTimer: {} as ReturnType<typeof setTimeout>,
  }) as unknown as SerialConnection;
  // A real session id is a 36-char UUID. The board holds the 31-byte cut its
  // sessions_list carried, asks with that, and strcmp()s the reply against it.
  const FULL_ID = 'a3dab322-5f0e-4c6b-9d1a-7e2f40c0ffee';
  const BOARD_ID = FULL_ID.slice(0, 31);
  const wire = (rows: Array<Record<string, unknown>>) => wireSessionTimelineReplies({
    resolveSessionId: (raw) => (typeof raw === 'string' && raw ? resolveSessionIdPrefix(raw, [FULL_ID]) : ''),
    entriesFor: (sessionId) => (sessionId === FULL_ID ? rows : []) as unknown as TimelineEntry[],
  });

  it('answers the board on its own line, under the id the board asked with', () => {
    const commands: unknown[] = [];
    setSerialCommandSink((cmd) => commands.push(cmd));
    wire([
      { ts: 1752700000000, type: 'chat_start', raw: 'run the suite', sessionId: FULL_ID },
      { ts: 1752700001000, type: 'tool_request', raw: 'Bash requested', sessionId: FULL_ID, toolEvent: true },
      // A long reply as the newest row: 9 KB of detail, past the whole budget.
      { ts: 1752700002000, type: 'chat_response', raw: 'x'.repeat(300), detail: '完'.repeat(3000), sessionId: FULL_ID },
    ]);
    try {
      const conn = queueConn();
      handleSerialLine(conn, JSON.stringify({ type: 'query_session_timeline', sessionId: BOARD_ID }));
      expect(commands).toEqual([]);
      expect(conn.writeQueue).toHaveLength(1);
      const reply = JSON.parse(conn.writeQueue[0]);
      expect(reply.type).toBe('timeline_history');
      expect(reply.sessionId).toBe(BOARD_ID);
      expect(reply.entries.map((e: { type: string }) => e.type)).toEqual(['chat_start', 'chat_response']);
      expect(reply.entries[1].raw).toHaveLength(119);
      expect(Buffer.byteLength(reply.entries[1].detail, 'utf8')).toBeLessThanOrEqual(199);
      expect(reply.entries[1].localHm).toMatch(/^\d\d:\d\d$/);

      // The commands that share the old forward list still reach the sink.
      handleSerialLine(conn, '{"type":"focus_session","sessionId":"s1"}');
      expect(commands).toEqual([{ type: 'focus_session', sessionId: 's1' }]);
    } finally {
      setSerialCommandSink(null);
      setSerialTimelineQueryHandler(null);
    }
  });

  it('sends nothing for a session with no rows to answer with', () => {
    wire([]);
    try {
      const conn = queueConn();
      handleSerialLine(conn, JSON.stringify({ type: 'query_session_timeline', sessionId: BOARD_ID }));
      handleSerialLine(conn, '{"type":"query_session_timeline","sessionId":""}');
      expect(conn.writeQueue).toEqual([]);
    } finally {
      setSerialTimelineQueryHandler(null);
    }
  });
});

// ─── WiFi provision message shape ───────────────────────────────────

describe('WiFi provision protocol', () => {
  it('provision message has all required fields', () => {
    const msg: WifiProvisionMessage = {
      type: 'wifi_provision',
      ssid: 'MyNetwork',
      password: 'secret123',
      bridgeIp: '192.168.1.50',
      bridgePort: 9120,
      authToken: 'abcdef0123456789',
    };

    expect(msg.type).toBe('wifi_provision');
    expect(typeof msg.ssid).toBe('string');
    expect(typeof msg.password).toBe('string');
    expect(typeof msg.bridgeIp).toBe('string');
    expect(typeof msg.bridgePort).toBe('number');
    expect(typeof msg.authToken).toBe('string');
  });

  it('auto-provisions first-setup boards and refreshes IPS10 endpoint while online', () => {
    expect(shouldSendWifiProvision({
      connected: true,
      provisionSent: false,
      deviceInfoFresh: true,
      deviceInfo: { board: 'ips_10', wifiConfigured: false, wifiConnected: false },
    } as any)).toBe(true);

    expect(shouldSendWifiProvision({
      connected: true,
      provisionSent: false,
      deviceInfoFresh: true,
      deviceInfo: { board: 'ips_10', wifiConfigured: true, wifiConnected: false, wifiRadioParked: true },
    } as any)).toBe(false);

    expect(shouldSendWifiProvision({
      connected: true,
      provisionSent: false,
      deviceInfoFresh: true,
      deviceInfo: { board: 'ips_10', wifiConfigured: true, wifiConnected: true },
    } as any)).toBe(true);

    expect(shouldSendWifiProvision({
      connected: true,
      provisionSent: false,
      deviceInfoFresh: true,
      deviceInfo: { board: 'ttgo_t_display', wifiConfigured: true, wifiConnected: true },
    } as any)).toBe(false);
  });

  it('decides on what the board said over this connection, not the device cache', () => {
    // A cache-seeded record describes an earlier connection and never carries
    // the credential id; the board's own device_info re-runs the fan-out.
    const parked = {
      connected: true,
      provisionSent: false,
      deviceInfo: { board: 't_embed', wifiConfigured: false, wifiConnected: false, wifiRadioParked: true },
    } as any;
    expect(shouldSendWifiProvision({ ...parked, deviceInfoFresh: false }, '4fbb066b2801b4ae')).toBe(false);
    expect(shouldSendWifiProvision({ ...parked, deviceInfoFresh: true }, '4fbb066b2801b4ae')).toBe(true);
  });

  it('leaves a parked board alone when it already holds these credentials', () => {
    const conn = (info: Record<string, unknown>) => ({
      connected: true, provisionSent: false, deviceInfoFresh: true, deviceInfo: info,
    } as any);
    const credId = '4fbb066b2801b4ae';
    // Generic board: the driver is off, so it reads unconfigured.
    const generic = { board: 't_embed', wifiConfigured: false, wifiConnected: false, wifiRadioParked: true };
    expect(shouldSendWifiProvision(conn({ ...generic, wifiCredId: credId }), credId)).toBe(false);
    expect(shouldSendWifiProvision(conn({ ...generic, wifiCredId: '' }), credId)).toBe(true);
    // Persisted board: reads configured from its own store, yet changed credentials reach it.
    const persisted = { board: 't_display_pro', wifiConfigured: true, wifiConnected: false, wifiRadioParked: true };
    expect(shouldSendWifiProvision(conn({ ...persisted, wifiCredId: '7de137f03d5a8983' }), credId)).toBe(true);
    expect(shouldSendWifiProvision(conn({ ...persisted, wifiCredId: credId }), credId)).toBe(false);
    // Firmware that predates the id keeps today's rule.
    expect(shouldSendWifiProvision(conn(generic), credId)).toBe(true);
    expect(shouldSendWifiProvision(conn(persisted), credId)).toBe(false);
    // So does a daemon with no id to offer.
    expect(shouldSendWifiProvision(conn({ ...persisted, wifiCredId: '7de137f03d5a8983' }), null)).toBe(false);
  });

  it('re-arms the pairing token on boards the WiFi gate skips', () => {
    // The case that broke the fleet: an online board holding a credential the
    // daemon stopped accepting. `shouldSendWifiProvision` refuses it on purpose
    // (re-injecting credentials fights the firmware's radio policy), so the
    // token would never reach it if the two shared a gate.
    const online = {
      connected: true,
      deviceInfoFresh: true,
      deviceInfo: { board: 'ttgo_t_display', wifiConfigured: true, wifiConnected: true },
    } as any;
    expect(shouldSendWifiProvision({ ...online, provisionSent: false })).toBe(false);
    expect(shouldSendAuthProvision(online, 'token-1')).toBe(true);
  });

  it('costs one write per board per token, not one per device_info frame', () => {
    const conn = {
      connected: true,
      deviceInfoFresh: true,
      deviceInfo: { board: '86box', wifiConfigured: true, wifiConnected: true },
      authTokenSent: 'token-1',
    } as any;
    expect(shouldSendAuthProvision(conn, 'token-1')).toBe(false);
    // …but a handover that changed the served token must reach the board.
    expect(shouldSendAuthProvision(conn, 'token-2')).toBe(true);
  });

  it('never writes a credential to an unidentified or empty peer', () => {
    expect(shouldSendAuthProvision({
      connected: true, deviceInfo: null,
    } as any, 'token-1')).toBe(false);

    // A record seeded from the device cache describes an earlier connection:
    // the tty may belong to another device now, or to a board still booting.
    expect(shouldSendAuthProvision({
      connected: true, deviceInfoFresh: false, deviceInfo: { board: '86box' },
    } as any, 'token-1')).toBe(false);

    expect(shouldSendAuthProvision({
      connected: false, deviceInfo: { board: '86box' },
    } as any, 'token-1')).toBe(false);

    // An absent token means "no information" — never "clear it".
    expect(shouldSendAuthProvision({
      connected: true, deviceInfo: { board: '86box' },
    } as any, '')).toBe(false);
  });
});

describe('serial provisioning fan-out over the live connection list', () => {
  const msg = buildWifiProvision({
    ssid: 'DeskNet', password: 'fanout-pw', bridgeIp: '192.168.1.50', bridgePort: 9120, authToken: 'fanout-token',
  });
  const parked = { wifiConfigured: false, wifiConnected: false, wifiRadioParked: true };

  function fakeConn(port: string, deviceInfo: Record<string, unknown>, deviceInfoFresh: boolean): SerialConnection {
    return {
      port,
      fd: null,
      stream: { destroyed: false, writable: true, write: () => true } as any,
      reader: null,
      readBuf: '',
      connected: true,
      deviceInfo: deviceInfo as SerialConnection['deviceInfo'],
      deviceInfoFresh,
      provisionSent: false,
      connectedAt: Date.now(),
      lastReadAt: Date.now(),
      lastWriteAt: Date.now(),
      lastDeviceInfoRequestAt: 0,
      deviceInfoRequestsSent: 0,
      writeQueue: [],
      writeTimer: null,
    };
  }

  /** Run `fn` against these connections only; stop their flush timers after. */
  function withConnections(conns: SerialConnection[], fn: () => void): void {
    const restore = __setConnectionsForTest(conns);
    try {
      fn();
    } finally {
      restore();
      for (const c of conns) {
        c.connected = false;
        if (c.writeTimer) clearTimeout(c.writeTimer);
      }
    }
  }

  const sentTypes = (c: SerialConnection) => c.writeQueue.map((json) => JSON.parse(json).type);

  it('sends WiFi credentials only to a board that identified here and holds other ones', () => {
    expect(msg.credId).toMatch(/^[0-9a-f]{16}$/);
    const holds = fakeConn('/dev/cu.fanout-holds', { board: 't_embed', ...parked, wifiCredId: msg.credId }, true);
    const differs = fakeConn('/dev/cu.fanout-differs', { board: 't_embed', ...parked, wifiCredId: '0000000000000000' }, true);
    const cached = fakeConn('/dev/cu.fanout-cached', { board: 't_embed', ...parked }, false);
    withConnections([holds, differs, cached], () => {
      expect(sendWifiProvisionToAll(msg)).toBe(1);
    });
    expect(sentTypes(holds)).toEqual([]);
    expect(sentTypes(differs)).toEqual(['wifi_provision']);
    expect(JSON.parse(differs.writeQueue[0]).credId).toBe(msg.credId);
    expect(sentTypes(cached)).toEqual([]);
  });

  it('arms the token only on a board that identified on this connection', () => {
    const live = fakeConn('/dev/cu.fanout-live', { board: '86box', ...parked }, true);
    const cached = fakeConn('/dev/cu.fanout-cached-auth', { board: '86box', ...parked }, false);
    let armed: string[] = [];
    withConnections([live, cached], () => {
      armed = sendAuthProvisionToAll({ type: 'auth_provision', authToken: 'fanout-token', bridgeIp: '192.168.1.50', bridgePort: 9120 });
    });
    expect(armed).toEqual([live.port]);
    expect(sentTypes(live)).toEqual(['auth_provision']);
    expect(sentTypes(cached)).toEqual([]);
  });

  it('sends the legacy re-arm only to identified firmware that reports no credential id', () => {
    const old = fakeConn('/dev/cu.fanout-old', { board: '86box', wifiConfigured: true, wifiConnected: false }, true);
    const knowsId = fakeConn('/dev/cu.fanout-new', { board: '86box', ...parked, wifiCredId: '' }, true);
    const cached = fakeConn('/dev/cu.fanout-cached-legacy', { board: '86box', wifiConfigured: true, wifiConnected: false }, false);
    withConnections([old, knowsId, cached], () => {
      expect(sendLegacyRearmProvision(old.port, msg)).toBe(true);
      // Firmware that reports the id also understands auth_provision: its
      // silence is a lost frame, and a full provision would wake its radio.
      expect(sendLegacyRearmProvision(knowsId.port, msg)).toBe(false);
      expect(sendLegacyRearmProvision(cached.port, msg)).toBe(false);
    });
    expect(sentTypes(old)).toEqual(['wifi_provision']);
    expect(sentTypes(knowsId)).toEqual([]);
    expect(sentTypes(cached)).toEqual([]);
    expect(shouldSendLegacyRearm({ connected: true, deviceInfoFresh: true, deviceInfo: { board: '86box', wifiCredId: '4fbb066b2801b4ae' } } as any)).toBe(false);
  });
});

// ─── Buffer overflow protection ─────────────────────────────────────

describe('serial buffer management', () => {
  it('line splitting handles multiple lines in one chunk', () => {
    let readBuf = '';
    const lines: string[] = [];
    const chunk = '{"type":"device_info","board":"86box","version":"1.0","wifiConfigured":false,"wifiConnected":false}\n{"type":"wifi_status","connected":true}\n';

    readBuf += chunk;
    let newlineIdx: number;
    while ((newlineIdx = readBuf.indexOf('\n')) !== -1) {
      const line = readBuf.slice(0, newlineIdx).trim();
      readBuf = readBuf.slice(newlineIdx + 1);
      if (line.length > 0) lines.push(line);
    }

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).type).toBe('device_info');
    expect(JSON.parse(lines[1]).type).toBe('wifi_status');
  });

  it('handles partial message across chunks', () => {
    let readBuf = '';
    const lines: string[] = [];

    readBuf += '{"type":"device_info","board":"86bo';

    let newlineIdx: number;
    while ((newlineIdx = readBuf.indexOf('\n')) !== -1) {
      const line = readBuf.slice(0, newlineIdx).trim();
      readBuf = readBuf.slice(newlineIdx + 1);
      if (line.length > 0) lines.push(line);
    }

    expect(lines).toHaveLength(0);

    readBuf += 'x","version":"1.0","wifiConfigured":false,"wifiConnected":false}\n';

    while ((newlineIdx = readBuf.indexOf('\n')) !== -1) {
      const line = readBuf.slice(0, newlineIdx).trim();
      readBuf = readBuf.slice(newlineIdx + 1);
      if (line.length > 0) lines.push(line);
    }

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).board).toBe('86box');
  });

  it('truncates buffer when exceeding 8KB limit', () => {
    let readBuf = 'x'.repeat(9000);
    if (readBuf.length > 8192) {
      readBuf = '';
    }
    expect(readBuf).toBe('');
  });
});

// ─── Foreign (non-AgentDeck) port denylist ──────────────────────────
// A USB-serial device that opens but never speaks the AgentDeck protocol (e.g. a
// TRMNL e-ink panel) must be denylisted so the scanner stops reopening — and
// DTR/RTS-resetting — it every poll. A real board that ever sent a valid JSON
// message must NEVER be classified as foreign.

const foreignConn = (over: Partial<SerialConnection> = {}): SerialConnection =>
  ({
    port: '/dev/cu.usbmodem201301',
    deviceInfo: null,
    lastReadAt: 0,
    ...over,
  }) as SerialConnection;

describe('foreign port detection', () => {
  it('flags a port that opened but never sent valid JSON', () => {
    expect(isUnidentifiedForeign(foreignConn())).toBe(true);
  });

  it('does NOT flag a connection that ever read a valid AgentDeck message', () => {
    expect(isUnidentifiedForeign(foreignConn({ lastReadAt: Date.now() }))).toBe(false);
  });

  it('does NOT flag a connection that already identified its board', () => {
    expect(isUnidentifiedForeign(foreignConn({ deviceInfo: { board: 'ips_10' } }))).toBe(false);
  });
});

describe('foreign port denylist threshold', () => {
  it('denylists a port only after repeated failed probes', () => {
    __resetForeignPortState();
    const port = '/dev/cu.usbmodem999';
    recordForeignProbeFailure(port);
    expect(isForeignPortDenylisted(port)).toBe(false); // 1
    recordForeignProbeFailure(port);
    expect(isForeignPortDenylisted(port)).toBe(false); // 2
    recordForeignProbeFailure(port);
    expect(isForeignPortDenylisted(port)).toBe(true); // 3 → denylisted
    __resetForeignPortState();
  });

  it('treats an elapsed cooldown as no longer denylisted', () => {
    __resetForeignPortState();
    const port = '/dev/cu.usbmodemAAA';
    for (let i = 0; i < 3; i++) recordForeignProbeFailure(port);
    expect(isForeignPortDenylisted(port)).toBe(true);
    // Far-future "now" — past the 10-minute cooldown window.
    expect(isForeignPortDenylisted(port, Date.now() + 20 * 60_000)).toBe(false);
    __resetForeignPortState();
  });
});

// ─── Half-open identified CDC recovery ──────────────────────────────
// An AgentDeck board on a CDC port (live or cache-restored device_info) that
// reads nothing since (re)connect is half-open: the board reset/re-enumerated and
// its RX pipe is dead, but heartbeat writes keep succeeding so the write-death
// reaper never fires. It must be recycled so re-poll re-probes — distinct from the
// foreign path, which owns *unidentified* ports.

const cdcConn = (over: Partial<SerialConnection> = {}): SerialConnection =>
  ({
    port: '/dev/cu.usbmodem2111201',
    deviceInfo: { board: 'round_amoled' },
    lastReadAt: 0,
    connectedAt: Date.now() - 5 * 60_000, // well past the 2-min grace
    ...over,
  }) as SerialConnection;

describe('half-open identified CDC recovery', () => {
  it('flags an identified CDC port that has never read since (re)connect', () => {
    expect(isHalfOpenIdentifiedCdc(cdcConn())).toBe(true); // the round_amoled live bug
  });

  it('does NOT flag while the read pipe is alive', () => {
    expect(isHalfOpenIdentifiedCdc(cdcConn({ lastReadAt: Date.now() }))).toBe(false);
  });

  it('does NOT flag inside the grace window after connect', () => {
    expect(isHalfOpenIdentifiedCdc(cdcConn({ connectedAt: Date.now() }))).toBe(false);
  });

  it('does NOT flag an unidentified CDC port — that is the foreign path', () => {
    const c = cdcConn({ deviceInfo: null });
    expect(isHalfOpenIdentifiedCdc(c)).toBe(false);
    expect(isUnidentifiedForeign(c)).toBe(true); // still owned by the foreign denylist
  });

  it('does NOT flag a UART (non-CDC) port — handled by the read-timeout branch', () => {
    expect(isHalfOpenIdentifiedCdc(cdcConn({ port: '/dev/cu.usbserial-1420' }))).toBe(false);
  });
});

// ─── Keepalive ack contract ─────────────────────────────────────────
// The firmware replies heartbeat_ack ONLY to lines containing the quoted
// substring `"keepalive"` (esp32/src/net/serial_client.cpp). Those acks are the
// sole periodic board→host liveness signal — every read-age check (isResponsive,
// both half-open reapers) assumes them. The former `serial_keepalive` type
// silently failed this match, so boards never acked.

describe('serial keepalive ack contract', () => {
  it('contains the quoted "keepalive" substring the firmware strstr-matches', () => {
    expect(SERIAL_KEEPALIVE_JSON).toContain('"keepalive"');
  });

  it('is the exact frame the deployed firmware acks', () => {
    expect(SERIAL_KEEPALIVE_JSON).toBe('{"type":"keepalive"}');
  });
});

// ─── Half-open identified UART recovery ─────────────────────────────
// The UART mirror of the CDC case above, for RX death MID-connection: the board
// identified and read fine, then went silent while 5s heartbeat writes keep
// writeAge ~0 — so the dual read+write stale clause can never fire. (2026-07-17
// live case: ips_10/ulanzi_tc001/ttgo silent 4–20+ min, transportOpen=true.)

const uartConn = (over: Partial<SerialConnection> = {}): SerialConnection =>
  ({
    port: '/dev/cu.wchusbserial21110',
    deviceInfo: { board: 'ips_10' },
    lastReadAt: Date.now() - 5 * 60_000, // read before, silent past the 3-min timeout
    connectedAt: Date.now() - 10 * 60_000,
    ...over,
  }) as SerialConnection;

describe('half-open identified UART recovery', () => {
  it('flags an identified UART whose RX died mid-connection', () => {
    expect(isSilentIdentifiedUart(uartConn())).toBe(true); // the ips_10/tc001 live bug
  });

  it('does NOT flag while reads are current', () => {
    expect(isSilentIdentifiedUart(uartConn({ lastReadAt: Date.now() }))).toBe(false);
  });

  it('does NOT flag below the silence timeout (one lost device_info is not death)', () => {
    expect(isSilentIdentifiedUart(uartConn({ lastReadAt: Date.now() - 90_000 }))).toBe(false);
  });

  it('does NOT flag a never-read UART — that is the initial-read/foreign path', () => {
    expect(isSilentIdentifiedUart(uartConn({ lastReadAt: 0 }))).toBe(false);
  });

  it('does NOT flag an unidentified UART', () => {
    // Fresh port so no other test's device_info cache entry can identify it.
    expect(isSilentIdentifiedUart(uartConn({ deviceInfo: null, port: '/dev/cu.wchusbserial77777' }))).toBe(false);
  });

  it('does NOT flag a CDC port — handled by isHalfOpenIdentifiedCdc/CDC clauses', () => {
    expect(isSilentIdentifiedUart(uartConn({ port: '/dev/cu.usbmodem2111201' }))).toBe(false);
  });
});

// ─── Device-info re-identify (cache-seed refresh) ───────────────────
// A cache-seeded connection carries a stale deviceInfo (old buildHash / pre-OTA
// fields) but deviceInfoFresh=false. The heartbeat identify loop must keep
// re-requesting until a LIVE reply lands, or a board reflashed/OTA-updated on
// the same port (e.g. trmnl_75 round8→round9) freezes at the cache seed in
// /devices. Regression guard for the conn.deviceInfo→conn.deviceInfoFresh gate.

const identifyConn = (over: Partial<SerialConnection> = {}): SerialConnection =>
  ({
    connected: true,
    deviceInfoFresh: false,
    deviceInfo: null,
    deviceInfoRequestsSent: 0,
    lastDeviceInfoRequestAt: 0,
    ...over,
  }) as SerialConnection;

describe('device-info re-identify gating', () => {
  it('retries a brand-new (unseeded) connection that has not yet identified', () => {
    expect(shouldRetryDeviceInfoIdentify(identifyConn())).toBe(true);
  });

  it('retries a CACHE-SEEDED connection (stale deviceInfo, not yet fresh) — the trmnl_75 bug', () => {
    // Non-null deviceInfo used to freeze this connection at the cache seed.
    const c = identifyConn({ deviceInfo: { board: 'trmnl_75', buildHash: 'b6744e8f-dirty' } });
    expect(shouldRetryDeviceInfoIdentify(c)).toBe(true);
  });

  it('STOPS once a live device_info has landed on this connection', () => {
    expect(shouldRetryDeviceInfoIdentify(identifyConn({ deviceInfoFresh: true, deviceInfo: { board: 'trmnl_75' } }))).toBe(false);
  });

  it('stops after the request budget is exhausted', () => {
    expect(shouldRetryDeviceInfoIdentify(identifyConn({ deviceInfoRequestsSent: 10 }))).toBe(false);
  });

  it('paces requests — no retry inside the retry interval', () => {
    const now = Date.now();
    expect(shouldRetryDeviceInfoIdentify(identifyConn({ lastDeviceInfoRequestAt: now }), now)).toBe(false);
    expect(shouldRetryDeviceInfoIdentify(identifyConn({ lastDeviceInfoRequestAt: now - 6000 }), now)).toBe(true);
  });

  it('does not retry a disconnected connection', () => {
    expect(shouldRetryDeviceInfoIdentify(identifyConn({ connected: false }))).toBe(false);
  });
});

describe('serial/WiFi display-path dedup', () => {
  const now = 1_000_000;

  it('does not suppress WiFi for a cache-seeded CDC port with no inbound traffic', () => {
    const c = identifyConn({
      port: '/dev/cu.usbmodem832401',
      connectedAt: now - 10_000,
      lastReadAt: 0,
      lastWriteAt: now,
      deviceInfo: { board: 't_display_pro', ip: '192.168.1.20', wifiConnected: true },
    });
    expect(isSerialReachableForDedup(c, now)).toBe(false);
  });

  it('suppresses WiFi only while a live device_info connection has recent inbound traffic', () => {
    const c = identifyConn({
      port: '/dev/cu.usbmodem832401',
      connectedAt: now - 10_000,
      lastReadAt: now - 1_000,
      lastWriteAt: now,
      deviceInfoFresh: true,
      deviceInfo: { board: 't_display_pro', ip: '192.168.1.20', wifiConnected: true },
    });
    expect(isSerialReachableForDedup(c, now)).toBe(true);
    expect(isSerialReachableForDedup({ ...c, lastReadAt: now - 61_000 }, now)).toBe(false);
  });
});

// ─── Open-failure backoff (GitHub #78) ──────────────────────────────
// Every open() toggles DTR/RTS and resets the attached board, so a port that
// keeps failing to open (a wedged CH340) must escalate its retry cadence rather
// than reboot a healthy board every poll. Must stay in lockstep with the Swift
// ESP32Serial.openFailureBackoff cadence (AgentDeckTests/ESP32WifiForwardTests).
describe('serialOpenFailureBackoffMs', () => {
  it('ramps 10→20→40→80→160→300s and reaches the 5-min block at the 6th failure', () => {
    const expected: Array<[number, number]> = [
      [1, 10_000], [2, 20_000], [3, 40_000], // below threshold: capped at 60s
      [4, 80_000], [5, 160_000],             // cap raised to 300s, still ramping
      [6, 300_000], [7, 300_000], [20, 300_000], // settled at the 5-min block
    ];
    for (const [failCount, ms] of expected) {
      expect(serialOpenFailureBackoffMs(failCount, false)).toBe(ms);
    }
  });

  it('never exceeds the 5-min block for any transient failCount', () => {
    for (let n = 1; n <= 200; n++) {
      expect(serialOpenFailureBackoffMs(n, false)).toBeLessThanOrEqual(300_000);
    }
  });

  it('uses the flat 5-min block for EACCES (permanent) failures', () => {
    for (let n = 1; n <= 5; n++) {
      expect(serialOpenFailureBackoffMs(n, true)).toBe(300_000);
    }
  });
});

describe('sanitizeRssiDbm', () => {
  it('keeps a plausible dBm reading, rounded', () => {
    expect(sanitizeRssiDbm(-67.4)).toBe(-67);
    expect(sanitizeRssiDbm(-120)).toBe(-120);
  });
  it('treats absent, zero, positive and non-numeric values as no reading', () => {
    for (const v of [undefined, null, 0, -0.1, -0.49, 5, -121, Number.NaN, '-60']) {
      expect(sanitizeRssiDbm(v)).toBeUndefined();
    }
  });
});
