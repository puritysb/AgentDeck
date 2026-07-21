/**
 * ESP32 serial bridge (Node.js side) — protocol and filtering tests.
 *
 * Tests the actual serial bridge source functions (prepareForSerial,
 * handleSerialLine, port patterns) without requiring real serial hardware.
 */
import { describe, it, expect } from 'vitest';
import { SERIAL_FORWARDED_EVENTS, DISPLAY_FORWARDED_EVENTS } from '@agentdeck/shared/protocol';
import type {
  StateUpdateEvent,
  UsageEvent,
  BridgeEvent,
  WifiProvisionMessage,
} from '@agentdeck/shared/protocol';
import { State, PermissionMode } from '@agentdeck/shared';
import {
  prepareForSerial,
  roundRobinByAgentType,
  SERIAL_SESSIONS_CAP,
  handleSerialLine,
  capturePanicLine,
  isRetryableSerialIoError,
  ESP32_PORT_PATTERNS,
  EXCLUDE_PATTERNS,
  isUnidentifiedForeign,
  isHalfOpenIdentifiedCdc,
  isSilentIdentifiedUart,
  SERIAL_KEEPALIVE_JSON,
  budgetTimelineEntries,
  serialOpenFailureBackoffMs,
  TIMELINE_HISTORY_BYTE_BUDGET,
  shouldSendWifiProvision,
  shouldRetryDeviceInfoIdentify,
  recordForeignProbeFailure,
  isForeignPortDenylisted,
  __resetForeignPortState,
  type SerialConnection,
} from '../esp32-serial.js';

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
    handleSerialLine(conn, '{"type":"device_info","board":"86box","version":"1.0.0","wifiConfigured":false,"wifiConnected":false}');

    expect(conn.deviceInfo).not.toBeNull();
    expect(conn.deviceInfo!.board).toBe('86box');
    expect(conn.deviceInfo!.version).toBe('1.0.0');
  });

  it('skips debug lines (non-JSON)', () => {
    const conn = mockConn();
    handleSerialLine(conn, '[WiFi] Connected to network');
    handleSerialLine(conn, 'Boot OK!');
    handleSerialLine(conn, 'E (1234) task_wdt: Task watchdog');
    handleSerialLine(conn, '');

    expect(conn.deviceInfo).toBeNull(); // Nothing parsed
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
      deviceInfo: { board: 'ips_10', wifiConfigured: false, wifiConnected: false },
    } as any)).toBe(true);

    expect(shouldSendWifiProvision({
      connected: true,
      provisionSent: false,
      deviceInfo: { board: 'ips_10', wifiConfigured: true, wifiConnected: false, wifiRadioParked: true },
    } as any)).toBe(false);

    expect(shouldSendWifiProvision({
      connected: true,
      provisionSent: false,
      deviceInfo: { board: 'ips_10', wifiConfigured: true, wifiConnected: true },
    } as any)).toBe(true);

    expect(shouldSendWifiProvision({
      connected: true,
      provisionSent: false,
      deviceInfo: { board: 'ttgo_t_display', wifiConfigured: true, wifiConnected: true },
    } as any)).toBe(false);
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
// the same port (e.g. inkdeck round8→round9) freezes at the cache seed in
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

  it('retries a CACHE-SEEDED connection (stale deviceInfo, not yet fresh) — the inkdeck bug', () => {
    // Non-null deviceInfo used to freeze this connection at the cache seed.
    const c = identifyConn({ deviceInfo: { board: 'inkdeck', buildHash: 'b6744e8f-dirty' } });
    expect(shouldRetryDeviceInfoIdentify(c)).toBe(true);
  });

  it('STOPS once a live device_info has landed on this connection', () => {
    expect(shouldRetryDeviceInfoIdentify(identifyConn({ deviceInfoFresh: true, deviceInfo: { board: 'inkdeck' } }))).toBe(false);
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
