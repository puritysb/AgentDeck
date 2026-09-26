import { randomUUID } from 'node:crypto';

export interface VoiceChat {
  state: string; sessionKey: string; runId: string; text?: string;
}
export interface PersonalVoiceGateway {
  beginPersonalActivity?(sessionKey: string): () => void;
  on(event: 'voice_chat', listener: (event: VoiceChat) => void): unknown;
  off(event: 'voice_chat', listener: (event: VoiceChat) => void): unknown;
  sendPersonalPrompt(text: string, sessionKey: string, idempotencyKey: string, thinking?: 'off' | 'low'): Promise<{ runId?: string }>;
}

/** Shared by live routing and offline evaluation; never send the invocation alone. */
export function personalVoiceCommand(text: string): string {
  return text.replace(/^\s*(?:오픈\s*클(?:로(?:우)?|록)|open\s*claw)[\s,.!?:，-]*/i, '').trim();
}

/** A device voice turn belongs to a personal session AND its acknowledged run.
 * Register before chat.send: an immediate final can precede the RPC response.
 * Never fall back to the gateway's most recently active (possibly cron) key. */
export async function startPersonalVoiceTurn(
  gateway: PersonalVoiceGateway, text: string, sessionKey = 'agent:main:main',
  timeoutMs = 10 * 60_000,
  thinking?: 'off' | 'low',
): Promise<{ runId: string; completion: Promise<string> }> {
  if (!/^agent:[^:]+:(?:main|voice)$/.test(sessionKey)) throw new Error('invalid_personal_session');
  const message = personalVoiceCommand(text);
  if (!message) throw new Error('no_command');
  let expected: string | undefined;
  const early = new Map<string, VoiceChat>();
  let lastText = '';
  let resolve!: (text: string) => void;
  let reject!: (error: Error) => void;
  let done = false;
  let endActivity: (() => void) | undefined;
  const completion = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  // A fast failure may arrive while the caller is still waiting for the ack.
  void completion.catch(() => {});
  const close = (error?: string, text?: string) => {
    if (done) return;
    done = true; clearTimeout(timer); gateway.off('voice_chat', listener);
    // Let the adapter finish processing a synchronous final before settling UI.
    if (endActivity) queueMicrotask(endActivity);
    error ? reject(new Error(error)) : resolve(text ?? '');
  };
  const consume = (event: VoiceChat) => {
    if (event.text) lastText = event.text.slice(0, 16000);
    if (event.state === 'final') close(undefined, lastText);
    else if (event.state === 'aborted' || event.state === 'error') close(`openclaw_${event.state}`);
  };
  const listener = (event: VoiceChat) => {
    if (done || event.sessionKey !== sessionKey || !event.runId) return;
    if (expected) { if (event.runId === expected) consume(event); return; }
    if (early.size >= 8 && !early.has(event.runId)) early.delete(early.keys().next().value!);
    const previous = early.get(event.runId);
    early.set(event.runId, { ...event, text: (event.text || previous?.text || '').slice(0, 16000) });
  };
  const timer = setTimeout(() => close('openclaw_reply_timeout'), timeoutMs);
  timer.unref?.();
  gateway.on('voice_chat', listener);
  try {
    endActivity = gateway.beginPersonalActivity?.(sessionKey);
    const id = randomUUID();
    const ack = await (thinking
      ? gateway.sendPersonalPrompt(message, sessionKey, id, thinking)
      : gateway.sendPersonalPrompt(message, sessionKey, id));
    if (typeof ack.runId !== 'string' || !ack.runId) throw new Error('openclaw_missing_run_id');
    expected = ack.runId;
    if (early.has(expected)) consume(early.get(expected)!);
    early.clear();
    return { runId: expected, completion };
  } catch (error) {
    close(error instanceof Error ? error.message : 'openclaw_send_failed');
    throw error;
  }
}
