import { describe, it, expect } from 'vitest';
import { askGateDecision, askPressVerdict } from '../ask-gate.js';

/**
 * The two decisions that make the ask-gate safe. Both fail silently in the
 * field — one leaves a terminal blank with nobody able to answer, the other
 * commits an answer the user never gave — so each rule gets an explicit case.
 */

describe('askGateDecision — who pays for the hold', () => {
  const host = (o: { tty?: string; appName?: string } | undefined) =>
    askGateDecision({ enabled: true, clientCount: 1, observed: o });

  it('holds only when there is no way to type into the session', () => {
    expect(host({}).hold).toBe(true);
  });

  it('never holds when the answer could be typed instead', () => {
    // Holding would make the person at that terminal wait for their own
    // picker; injection answers it with no delay at all.
    expect(host({ tty: 'ttys006' }).hold).toBe(false);
    expect(host({ appName: 'Claude' }).hold).toBe(false);
  });

  it('never holds a session no device can see', () => {
    // The observer roster is the only source of observed:claude:* rows, so a
    // session missing from it is a session missing from every deck. Holding
    // there stalls a question with nobody to answer it — the inverse of the
    // intent. Reachable for real: a session younger than the scan interval, or
    // any ps failure, empties that roster.
    const d = host(undefined);
    expect(d.hold).toBe(false);
    expect(d.reason).toMatch(/roster/);
  });

  it('never holds with the gate off or nobody connected', () => {
    expect(askGateDecision({ enabled: false, clientCount: 1, observed: {} }).hold).toBe(false);
    expect(askGateDecision({ enabled: true, clientCount: 0, observed: {} }).hold).toBe(false);
  });
});

describe('askPressVerdict — what may commit an answer', () => {
  const overlay = {
    question: 'Which colour do you prefer?',
    options: [{ index: 0, label: 'Red' }, { index: 1, label: 'Blue' }],
    toolUseId: 'toolu-1',
  };
  const press = (command: Record<string, unknown>, gateToolUseId = 'toolu-1') =>
    askPressVerdict({ overlay, gateToolUseId, command });

  it('accepts a press that names the live question', () => {
    const v = press({ type: 'select_option', index: 1, question: overlay.question });
    expect(v).toEqual({ ok: true, label: 'Blue' });
  });

  it('refuses a press that does not name its question', () => {
    // This is the ESP32/NFC "approve" key, which sends select_option(0) as a
    // stand-in for a yes/no gate. Against a multiple-choice question that is a
    // guess, and accepting it would submit option 0 as the user's own answer.
    const v = press({ type: 'select_option', index: 0 });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toMatch(/name its question/);
      // Nothing to resync — that sender has no question view to correct.
      expect(v.resync).toBe(false);
    }
  });

  it('refuses a press aimed at a question the prompt moved past', () => {
    const v = press({ type: 'select_option', index: 0, question: 'Which animal do you prefer?' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.resync).toBe(true);
  });

  it('refuses to answer an overlay the held gate does not own', () => {
    // A malformed follow-up call can leave the previous prompt resident;
    // answering it would report the wrong question back to the agent.
    const v = press({ type: 'select_option', index: 0, question: overlay.question }, 'toolu-other');
    expect(v.ok).toBe(false);
  });

  it('refuses anything that is not an option selection', () => {
    // A yes/no `respond` must never collapse a multiple-choice question.
    expect(press({ type: 'respond', value: 'y', question: overlay.question }).ok).toBe(false);
  });

  it('refuses an index that is not in the live option list', () => {
    const v = press({ type: 'select_option', index: 7, question: overlay.question });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.resync).toBe(true);
  });

  it('matches on the option index, not its array position', () => {
    // The wire index is server-assigned; a surface echoes it back verbatim.
    const v = askPressVerdict({
      overlay: { question: 'Q', options: [{ index: 4, label: 'Four' }], toolUseId: 't' },
      gateToolUseId: 't',
      command: { type: 'select_option', index: 4, question: 'Q' },
    });
    expect(v).toEqual({ ok: true, label: 'Four' });
  });

  it('refuses when no question is open at all', () => {
    expect(askPressVerdict({
      overlay: undefined, gateToolUseId: 't', command: { type: 'select_option', index: 0, question: 'Q' },
    }).ok).toBe(false);
  });
});
