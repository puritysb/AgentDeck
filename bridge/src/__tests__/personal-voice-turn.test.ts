import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { startPersonalVoiceTurn, personalVoicePrompt, completedVoiceSummary } from '../personal-voice-turn.js';

class Gateway extends EventEmitter {
  sendPersonalPrompt = vi.fn(async (_text: string, _key: string, _id: string) => ({runId:'mine'}));
  chat(runId: string, sessionKey = 'agent:main:main', state = 'final', text = 'answer') {
    this.emit('voice_chat', {runId,sessionKey,state,text});
  }
}
describe('personal voice turn',()=>{
  it('passes an explicit voice-only thinking override without changing the session key', async () => {
    const g = new Gateway();
    const turn = await startPersonalVoiceTurn(g, '연결 확인', undefined, undefined, 'off');
    expect(g.sendPersonalPrompt).toHaveBeenCalledWith(personalVoicePrompt('연결 확인'), 'agent:main:main', expect.any(String), 'off');
    g.chat('mine'); await turn.completion;
  });
  it('allows a dedicated voice conversation on the same personal agent', async () => {
    const g = new Gateway();
    const turn = await startPersonalVoiceTurn(g, '연결 확인', 'agent:main:voice', undefined, 'low');
    g.chat('mine', 'agent:main:main');
    expect(g.listenerCount('voice_chat')).toBe(1);
    g.chat('mine', 'agent:main:voice');
    await expect(turn.completion).resolves.toBe('answer');
  });
  it('removes the local recognizer spelling of the wake word', async () => {
    const g = new Gateway(); const turn = await startPersonalVoiceTurn(g, '오픈클록. 음성 연결 확인');
    expect(g.sendPersonalPrompt).toHaveBeenCalledWith(personalVoicePrompt('음성 연결 확인'), 'agent:main:main', expect.any(String));
    g.chat('mine'); await turn.completion;
  });
  it('routes to the personal conversation and ignores other runs/cron replies',async()=>{
    const g=new Gateway();const turn=await startPersonalVoiceTurn(g,'오픈클로, 상태 알려줘');
    expect(g.sendPersonalPrompt).toHaveBeenCalledWith(personalVoicePrompt('상태 알려줘'),'agent:main:main',expect.any(String));
    let done=false;void turn.completion.then(()=>{done=true;});
    g.chat('mine','agent:main:cron:job');g.chat('someone-else');await Promise.resolve();expect(done).toBe(false);
    g.chat('mine');await expect(turn.completion).resolves.toBe('answer');expect(g.listenerCount('voice_chat')).toBe(0);
  });
  it('retains a completion that precedes the send acknowledgement',async()=>{
    const g=new Gateway();g.sendPersonalPrompt.mockImplementation(async()=>{g.chat('mine');return {runId:'mine'};});
    const turn=await startPersonalVoiceTurn(g,'test');await expect(turn.completion).resolves.toBe('answer');
  });
  it('uses only matching delta text when final has no text',async()=>{
    const g=new Gateway();const turn=await startPersonalVoiceTurn(g,'test');
    g.chat('mine',undefined,'delta','my answer');g.chat('other',undefined,'delta','wrong answer');g.chat('mine',undefined,'final','');
    await expect(turn.completion).resolves.toBe('my answer');
  });
  it('cleans listeners on refusal and never substitutes a different conversation',async()=>{
    const g=new Gateway();g.sendPersonalPrompt.mockRejectedValue(new Error('offline'));
    await expect(startPersonalVoiceTurn(g,'test')).rejects.toThrow('offline');expect(g.listenerCount('voice_chat')).toBe(0);
    await expect(startPersonalVoiceTurn(g,'오픈클로')).rejects.toThrow('no_command');
    await expect(startPersonalVoiceTurn(g,'test','agent:main:cron:x')).rejects.toThrow('invalid_personal_session');
  });
  it('bounds peer silence and handles aborted requests',async()=>{
    vi.useFakeTimers();const g=new Gateway();const turn=await startPersonalVoiceTurn(g,'test',undefined,1000);
    const pending=expect(turn.completion).rejects.toThrow('timeout');await vi.advanceTimersByTimeAsync(1001);await pending;
    expect(g.listenerCount('voice_chat')).toBe(0);vi.useRealTimers();
    const next=await startPersonalVoiceTurn(g,'test');g.chat('mine',undefined,'aborted');await expect(next.completion).rejects.toThrow('aborted');
  });
});


describe('personal speech readiness', () => {
  it('waits for a closed explicit summary and speaks it before the final details', async () => {
    const g = new Gateway();
    const turn = await startPersonalVoiceTurn(g, 'test', undefined, undefined, undefined, { earlySummary: true });
    let spoken = false, completed = false;
    void turn.speech.then(() => { spoken = true; });
    void turn.completion.then(() => { completed = true; });
    g.chat('other', undefined, 'delta', '요약: 남의 답.\n\n');
    g.chat('mine', undefined, 'delta', '요약: 연결을 복구했습니다.');
    await Promise.resolve(); expect(spoken).toBe(false);
    const answer = '요약: 연결을 복구했습니다. 재시도하면 됩니다.\n\n상세 설명';
    g.chat('mine', undefined, 'delta', answer);
    await expect(turn.speech).resolves.toBe('Summary: 연결을 복구했습니다. 재시도하면 됩니다.');
    expect(completed).toBe(false);
    g.chat('mine', undefined, 'final', answer + '이 끝났습니다.');
    await expect(turn.completion).resolves.toBe(answer + '이 끝났습니다.');
  });

  it('does not treat an acknowledgement, an unfinished paragraph or a code block as a ready summary', () => {
    for (const text of ['네, 확인했습니다.\n\n', '요약: 아직 작성', '요약: 한 줄.\n', '```\n요약: 코드입니다.\n\n', '요약: ' + '긴'.repeat(241) + '\n\n']) {
      expect(completedVoiceSummary(text)).toBeUndefined();
    }
    expect(completedVoiceSummary('Summary: Restored the connection.\r\n\r\nDetails')).toBe('Restored the connection.');
  });

  it('keeps full-reply consumers waiting for the final', async () => {
    const g = new Gateway(); const turn = await startPersonalVoiceTurn(g, 'test');
    let spoken = false; void turn.speech.then(() => { spoken = true; });
    g.chat('mine', undefined, 'delta', '요약: 준비됐습니다.\n\n');
    await Promise.resolve(); expect(spoken).toBe(false);
    g.chat('mine'); await expect(turn.speech).resolves.toBe('answer');
  });

  it('recovers an empty final only from a late snapshot of the same run', async () => {
    vi.useFakeTimers();
    try {
      const g = new Gateway(); const turn = await startPersonalVoiceTurn(g, 'test');
      g.chat('mine', undefined, 'final', '   ');
      g.chat('other', undefined, 'delta', 'unrelated');
      await vi.advanceTimersByTimeAsync(500);
      expect(g.listenerCount('voice_chat')).toBe(1);
      g.chat('mine', undefined, 'delta', 'recovered');
      await expect(turn.completion).resolves.toBe('recovered');
      await expect(turn.speech).resolves.toBe('recovered');
      expect(g.listenerCount('voice_chat')).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('rejects an unrecoverable empty final promptly instead of silently succeeding', async () => {
    vi.useFakeTimers();
    try {
      const g = new Gateway(); const turn = await startPersonalVoiceTurn(g, 'test');
      const completion = expect(turn.completion).rejects.toThrow('openclaw_empty_reply');
      const speech = expect(turn.speech).rejects.toThrow('openclaw_empty_reply');
      g.chat('mine', undefined, 'final', '');
      await vi.advanceTimersByTimeAsync(1500);
      await completion; await speech;
      expect(g.listenerCount('voice_chat')).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('preserves a final received before acknowledgement even when a late delta follows', async () => {
    const g = new Gateway();
    g.sendPersonalPrompt.mockImplementation(async () => {
      g.chat('mine', undefined, 'final', '');
      g.chat('mine', undefined, 'delta', 'recovered before ack');
      return { runId: 'mine' };
    });
    const turn = await startPersonalVoiceTurn(g, 'test');
    await expect(turn.completion).resolves.toBe('recovered before ack');
  });

  it('does not hide an abort that arrives before acknowledgement', async () => {
    const g = new Gateway();
    g.sendPersonalPrompt.mockImplementation(async () => {
      g.chat('mine', undefined, 'final', '');
      g.chat('mine', undefined, 'aborted', '');
      return { runId: 'mine' };
    });
    const turn = await startPersonalVoiceTurn(g, 'test');
    await expect(turn.completion).rejects.toThrow('openclaw_aborted');
    await expect(turn.speech).rejects.toThrow('openclaw_aborted');
  });
});
