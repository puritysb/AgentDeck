import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEVICE_CONTROLLER_RULES, hasControllerInput, hasControllerAnswer, compactControllerCapabilities } from '../device-controller.js';
import { emitSwift, output, emitCpp, cppOutput, emitKotlin, kotlinOutput } from '../../../scripts/generate-device-controller-rules.mjs';
import type { SessionInfo } from '../protocol.js';
import { renderOptionButton } from '../svg-renderers/session-slot-renderer.js';

describe('device controller delivery and mirrors', () => {
  const row = (agentType: string, controlMode: string, alive = true) => ({ agentType, controlMode, alive } as SessionInfo);
  it('keeps notify-only, unknown and dead observed sessions free of input controls', () => {
    for (const agent of ['codex', 'kiro', 'hermes', 'unknown']) expect(hasControllerInput(row(agent, 'observed'))).toBe(false);
    expect(hasControllerInput(undefined)).toBe(false);
    expect(hasControllerInput(row('opencode', 'observed', false))).toBe(false);
    expect(hasControllerInput(row('opencode', 'observed'))).toBe(true);
    expect(hasControllerInput(row('claude-code', 'observed'))).toBe(true);
    expect(hasControllerInput(row('codex', 'managed'))).toBe(true);
  });
  it('keeps the Swift preview contract generated from the same key and delivery rules', () => {
    expect(readFileSync(new URL('../../../' + output, import.meta.url), 'utf8')).toBe(emitSwift(DEVICE_CONTROLLER_RULES));
    expect(readFileSync(new URL('../../../' + cppOutput, import.meta.url), 'utf8')).toBe(emitCpp(DEVICE_CONTROLLER_RULES));
    expect(readFileSync(new URL('../../../' + kotlinOutput, import.meta.url), 'utf8')).toBe(emitKotlin(DEVICE_CONTROLLER_RULES));
  });
  it('requires real options and delivery, or a native held permission request', () => {
    const waiting = { ...row('opencode', 'observed'), state: 'awaiting_permission' } as SessionInfo;
    expect(hasControllerAnswer(waiting)).toBe(false);
    expect(hasControllerAnswer({ ...waiting, requestId: 'ocperm:session:request', liveAnswerable: false })).toBe(false);
    expect(hasControllerAnswer({ ...waiting, requestId: 'ocperm:session:request', liveAnswerable: true })).toBe(true);
    expect(hasControllerAnswer({ ...waiting, requestId: 'held-claude-tool', liveAnswerable: false })).toBe(true);
    expect(hasControllerAnswer({ ...waiting, controlMode: 'managed', options: [{ label: 'Yes' }] })).toBe(true);
    expect(compactControllerCapabilities({ ...waiting, requestId: 'held', question: '가'.repeat(80) }).controllerAnswerable).toBe(false);
    expect(compactControllerCapabilities({ ...waiting, requestId: 'held', options: [{label: '가'.repeat(22), index: 0}] }).controllerAnswerable).toBe(false);
    expect(compactControllerCapabilities({ ...waiting, requestId: 'held', options: [{label: 'A'.repeat(63), index: 0}] }).controllerAnswerable).toBe(true);
    expect(compactControllerCapabilities({ ...waiting, state: 42, requestId: {} } as unknown as SessionInfo).controllerAnswerable).toBe(false);
  });
  it('uses readable fixed-size decision text, bounded lines and visible truncation', () => {
    const key = DEVICE_CONTROLLER_RULES.key;
    for (const label of ['Allow once', 'Deny', '지금 이 작업만 허용합니다', 'A deliberately long choice that cannot fit in one physical key']) {
      const svg = renderOptionButton({ label, index: 0 }, 0);
      const labels = [...svg.matchAll(new RegExp(`<text[^>]*font-size="${key.optionFont}"[^>]*>(.*?)</text>`, 'g'))];
      expect(labels.length).toBeGreaterThan(0);
      expect(labels.length).toBeLessThanOrEqual(key.optionLines);
      if (label.startsWith('A deliberately')) expect(labels.at(-1)?.[1]).toContain('…');
      expect(svg).not.toMatch(/font-size="1[23]"[^>]*>Allow/);
    }
  });
});
