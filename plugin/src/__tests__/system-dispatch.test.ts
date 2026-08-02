/**
 * System facade — platform dispatch + dial-rotation debounce.
 *
 * `selectBackend` takes the platform as an argument precisely so these tests
 * never branch on (or mutate) the host platform. Both backends are mocked with
 * a SHARED setVolumeNow spy, so the debounce assertions hold identically no
 * matter which backend the module-scope binding picked on import.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { VolumeSettings } from '../system/types.js';

const { setVolumeNow, fakeBackend } = vi.hoisted(() => {
  const setVolumeNowSpy = vi.fn<(vol: number) => Promise<void>>(async () => {});
  return {
    setVolumeNow: setVolumeNowSpy,
    fakeBackend: () => ({
      isVolumeSupported: async () => true,
      getVolumeSettings: async (): Promise<VolumeSettings> => ({ outputVolume: 50, outputMuted: false }),
      setVolumeNow: setVolumeNowSpy,
      setOutputMuted: async () => {},
      openUrl: async () => {},
      openApp: async () => {},
      openAgentDeckAppOrGitHub: async () => {},
    }),
  };
});

vi.mock('../system/darwin.js', () => ({ darwinBackend: fakeBackend() }));
vi.mock('../system/win32.js', () => ({ win32Backend: fakeBackend() }));

import { darwinBackend } from '../system/darwin.js';
import { win32Backend } from '../system/win32.js';
import { selectBackend, setOutputVolume } from '../system/index.js';

describe('system: selectBackend platform mapping', () => {
  it('maps win32 to the windows backend', () => {
    expect(selectBackend('win32')).toBe(win32Backend);
  });

  it('maps darwin to the mac backend', () => {
    expect(selectBackend('darwin')).toBe(darwinBackend);
  });

  it('falls back to the mac backend on platforms the Stream Deck app does not exist on', () => {
    expect(selectBackend('linux')).toBe(darwinBackend);
    expect(selectBackend('freebsd')).toBe(darwinBackend);
  });
});

describe('system: setOutputVolume debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVolumeNow.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces rapid rotation — only the final value commits', async () => {
    setOutputVolume(10);
    setOutputVolume(20);
    setOutputVolume(30);
    expect(setVolumeNow).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(150);
    expect(setVolumeNow).toHaveBeenCalledTimes(1);
    expect(setVolumeNow).toHaveBeenCalledWith(30);
  });

  it('commits again after the debounce window settles', async () => {
    setOutputVolume(10);
    await vi.advanceTimersByTimeAsync(150);
    setOutputVolume(60);
    await vi.advanceTimersByTimeAsync(150);
    expect(setVolumeNow).toHaveBeenCalledTimes(2);
    expect(setVolumeNow).toHaveBeenLastCalledWith(60);
  });

  it('swallows backend failures — a bad tick must not become an unhandled rejection', async () => {
    setVolumeNow.mockRejectedValueOnce(new Error('osascript ENOENT'));
    setOutputVolume(42);
    await vi.advanceTimersByTimeAsync(150);
    expect(setVolumeNow).toHaveBeenCalledWith(42);
    // reaching here without vitest flagging an unhandled rejection is the assertion
  });
});
