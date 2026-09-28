import { randomUUID } from 'node:crypto';
import { SPOKEN_DIGEST_MAX_CHARS } from '@agentdeck/shared';

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

/** Keep this instruction turn-local: do not change the user's personal session. */
export function personalVoicePrompt(command: string): string {
  return `${command}\n\n[음성 응답 형식 / Voice reply format]\n`
    + '결과가 확정된 최종 답변은 사용자 언어로 "요약: " 또는 "Summary: "로 시작하는 '
    + `핵심 답 1~2문장(${SPOKEN_DIGEST_MAX_CHARS}자 이내)을 먼저 쓰고 빈 줄로 끝내세요. `
    + '인사나 확인했다는 말 대신 실제 답, 결과 또는 실패 이유를 말하세요. '
    + '도구 실행 중인 설명에는 이 요약 형식을 쓰지 마세요. '
    + '상세 설명은 요청했거나 꼭 필요한 경우에만 요약 뒤에 쓰세요. '
    + 'Start the final answer with a short, confirmed result in the user’s language, '
    + 'labelled "Summary: " (or "요약: "), followed by a blank line. '
    + 'Do not use that label for acknowledgements or work in progress.';
}

/** Only a closed, explicitly labelled opening paragraph can be spoken early.
 * An arbitrary first delta can be a heading, acknowledgement or partial fact. */
export function completedVoiceSummary(text: string): string | undefined {
  const match = text.match(/^\s*(?:요약|Summary):[ \t]*([^\n]+)\r?\n[ \t]*\r?\n/i);
  const summary = match?.[1].trim();
  if (!summary || summary.length > SPOKEN_DIGEST_MAX_CHARS || /```/.test(summary)) return undefined;
  return summary;
}

/** A device voice turn belongs to a personal session AND its acknowledged run.
 * Register before chat.send: an immediate final can precede the RPC response.
 * Never fall back to the gateway's most recently active (possibly cron) key. */
export async function startPersonalVoiceTurn(
  gateway: PersonalVoiceGateway, text: string, sessionKey = 'agent:main:main',
  timeoutMs = 10 * 60_000,
  thinking?: 'off' | 'low',
  options: { earlySummary?: boolean } = {},
): Promise<{ runId: string; completion: Promise<string>; speech: Promise<string> }> {
  if (!/^agent:[^:]+:(?:main|voice)$/.test(sessionKey)) throw new Error('invalid_personal_session');
  const message = personalVoiceCommand(text);
  if (!message) throw new Error('no_command');
  let expected: string | undefined;
  const early = new Map<string, VoiceChat>();
  let lastText = '';
  let resolve!: (text: string) => void;
  let reject!: (error: Error) => void;
  let done = false;
  let emptyFinalTimer: ReturnType<typeof setTimeout> | undefined;
  let endActivity: (() => void) | undefined;
  const completion = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  let resolveSpeech!: (text: string) => void;
  let rejectSpeech!: (error: Error) => void;
  const speech = new Promise<string>((yes, no) => { resolveSpeech = yes; rejectSpeech = no; });
  // A fast failure may arrive while the caller is still waiting for the ack.
  void completion.catch(() => {});
  void speech.catch(() => {});
  const close = (error?: string, text?: string) => {
    if (done) return;
    done = true; clearTimeout(timer); clearTimeout(emptyFinalTimer); gateway.off('voice_chat', listener);
    // Let the adapter finish processing a synchronous final before settling UI.
    if (endActivity) queueMicrotask(endActivity);
    if (error) { reject(new Error(error)); rejectSpeech(new Error(error)); }
    else { resolve(text ?? ''); resolveSpeech(text ?? ''); }
  };
  const consume = (event: VoiceChat) => {
    if (event.state === 'aborted' || event.state === 'error') {
      close(`openclaw_${event.state}`); return;
    }
    if (event.text?.trim()) lastText = event.text.slice(0, 16000);
    if (options.earlySummary && event.state === 'delta') {
      const summary = completedVoiceSummary(lastText);
      if (summary) resolveSpeech(`Summary: ${summary}`);
    }
    if (event.state === 'final' || emptyFinalTimer) {
      if (lastText.trim()) close(undefined, lastText);
      // A late snapshot for THIS run can repair an empty final. Never read the
      // latest message from a shared session: it may belong to another request.
      else if (!emptyFinalTimer) {
        emptyFinalTimer = setTimeout(() => close('openclaw_empty_reply'), 1500);
        emptyFinalTimer.unref?.();
      }
    }
  };
  const listener = (event: VoiceChat) => {
    if (done || event.sessionKey !== sessionKey || !event.runId) return;
    if (expected) { if (event.runId === expected) consume(event); return; }
    if (early.size >= 8 && !early.has(event.runId)) early.delete(early.keys().next().value!);
    const previous = early.get(event.runId);
    const state = event.state === 'delta' && previous && ['final', 'error', 'aborted'].includes(previous.state)
      ? previous.state : event.state;
    early.set(event.runId, { ...event, state, text: (event.text?.trim() ? event.text : previous?.text || '').slice(0, 16000) });
  };
  const timer = setTimeout(() => close('openclaw_reply_timeout'), timeoutMs);
  timer.unref?.();
  gateway.on('voice_chat', listener);
  try {
    endActivity = gateway.beginPersonalActivity?.(sessionKey);
    const id = randomUUID();
    const ack = await (thinking
      ? gateway.sendPersonalPrompt(personalVoicePrompt(message), sessionKey, id, thinking)
      : gateway.sendPersonalPrompt(personalVoicePrompt(message), sessionKey, id));
    if (typeof ack.runId !== 'string' || !ack.runId) throw new Error('openclaw_missing_run_id');
    expected = ack.runId;
    if (early.has(expected)) consume(early.get(expected)!);
    early.clear();
    return { runId: expected, completion, speech };
  } catch (error) {
    close(error instanceof Error ? error.message : 'openclaw_send_failed');
    throw error;
  }
}
