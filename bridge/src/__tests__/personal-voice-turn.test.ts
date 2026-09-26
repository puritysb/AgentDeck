import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { startPersonalVoiceTurn } from '../personal-voice-turn.js';

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
    expect(g.sendPersonalPrompt).toHaveBeenCalledWith('연결 확인', 'agent:main:main', expect.any(String), 'off');
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
    expect(g.sendPersonalPrompt).toHaveBeenCalledWith('음성 연결 확인', 'agent:main:main', expect.any(String));
    g.chat('mine'); await turn.completion;
  });
  it('routes to the personal conversation and ignores other runs/cron replies',async()=>{
    const g=new Gateway();const turn=await startPersonalVoiceTurn(g,'오픈클로, 상태 알려줘');
    expect(g.sendPersonalPrompt).toHaveBeenCalledWith('상태 알려줘','agent:main:main',expect.any(String));
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
