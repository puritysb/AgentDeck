import { describe, expect, it, vi } from 'vitest';
import { HermesSessionObserver } from '../hermes-session-observer.js';

describe('HermesSessionObserver', () => {
  it('tracks a lifecycle as a read-only observed session', () => {
    const changed = vi.fn();
    const observer = new HermesSessionObserver(changed);
    const start = 1_800_000_000_000;

    observer.ingest(
      'session_start',
      {
        session_id: 'session-1',
        cwd: '/srv/example',
        model: 'provider/model',
        platform: 'chat',
      },
      start,
    );
    observer.ingest(
      'user_prompt_submit',
      {
        session_id: 'session-1',
        prompt: 'Review the release',
      },
      start + 1,
    );
    observer.ingest(
      'tool_start',
      {
        session_id: 'session-1',
        tool_name: 'terminal',
      },
      start + 2,
    );

    expect(observer.collect(start + 3)).toEqual([
      expect.objectContaining({
        id: 'observed:hermes:session-1',
        projectName: 'example',
        agentType: 'hermes',
        controlMode: 'observed',
        state: 'processing',
        modelName: 'provider/model',
        currentTool: 'terminal',
        currentTask: 'Review the release',
        goal: 'Review the release',
      }),
    ]);

    observer.ingest('tool_end', { session_id: 'session-1', tool_name: 'terminal' }, start + 4);
    observer.ingest('stop', { session_id: 'session-1' }, start + 5);
    expect(observer.collect(start + 6)[0]).toMatchObject({ state: 'idle', currentTool: undefined });

    observer.ingest('session_end', { session_id: 'session-1' }, start + 7);
    expect(observer.collect(start + 8)).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(6);
  });

  it('expires interrupted processing sessions after three minutes', () => {
    const observer = new HermesSessionObserver();
    const start = 1_800_000_000_000;
    observer.ingest(
      'user_prompt_submit',
      {
        session_id: 'session-1',
        prompt: 'Review the release',
      },
      start,
    );

    expect(observer.collect(start + 3 * 60 * 1000)).toHaveLength(1);
    expect(observer.collect(start + 3 * 60 * 1000 + 1)).toEqual([]);
  });

  it('ignores one-shot events without a durable session id', () => {
    const observer = new HermesSessionObserver();
    observer.ingest('user_prompt_submit', { prompt: 'Review the release' });
    expect(observer.collect()).toEqual([]);
  });
});
