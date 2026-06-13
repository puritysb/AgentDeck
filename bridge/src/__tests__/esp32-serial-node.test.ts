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
  DeviceInfoMessage,
  WifiProvisionMessage,
} from '@agentdeck/shared/protocol';
import { State, PermissionMode } from '@agentdeck/shared';
import {
  prepareForSerial,
  roundRobinByAgentType,
  SERIAL_SESSIONS_CAP,
  handleSerialLine,
  isRetryableSerialIoError,
  ESP32_PORT_PATTERNS,
  EXCLUDE_PATTERNS,
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

  it('round-robins sessions_list by agent type so non-Claude agents survive the cap', () => {
    // 6 alive Claude sessions ahead of Codex + OpenClaw — the real-world layout
    // that previously dropped Codex (index 6) via a plain slice(0, 6).
    const sessions = [
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `cc-${i}`, agentType: 'claude-code', state: 'idle', alive: true, port: 9120 + i,
      })),
      { id: 'cc-busy', agentType: 'claude-code', state: 'processing', alive: true, port: 9130 },
      { id: 'cx', agentType: 'codex-cli', state: 'idle', alive: true, port: 9140 },
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

  it('passes through other events unchanged', () => {
    const event: BridgeEvent = {
      type: 'connection',
      status: 'connected',
      sessionId: 'abc',
    };

    const prepared = prepareForSerial(event);
    expect(prepared).toEqual(event);
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
