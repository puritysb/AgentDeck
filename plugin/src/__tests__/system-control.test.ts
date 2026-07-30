import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSystemControl, type ProcessRunner } from '../utility-modes/system-control.js';

describe('system control platform dispatch', () => {
  let run: ReturnType<typeof vi.fn<ProcessRunner>>;

  beforeEach(() => {
    run = vi.fn<ProcessRunner>(async () => '');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps macOS volume readback and absolute setters on osascript', async () => {
    run.mockResolvedValueOnce(
      'output volume:65, input volume:80, alert volume:100, output muted:true',
    );
    const control = createSystemControl('darwin', run);

    await expect(control.getVolumeSettings()).resolves.toEqual({
      outputVolume: 65,
      outputMuted: true,
    });
    expect(control.supportsVolumeReadback).toBe(true);
    expect(run).toHaveBeenCalledWith(
      'osascript',
      ['-e', 'get volume settings'],
      { timeout: 5000 },
    );
  });

  it('opens a Windows URL without interpolating the target into PowerShell code', async () => {
    const control = createSystemControl('win32', run);
    const hostile = 'https://example.test/a?x=1&y=$(whoami)';

    await control.openOrFocusBrowserTab(hostile);

    expect(control.supportsVolumeReadback).toBe(false);
    const [executable, args, options] = run.mock.calls[0];
    expect(executable).toBe('powershell.exe');
    expect(args.at(-1)).toBe('Start-Process -FilePath $env:AGENTDECK_LAUNCH_TARGET');
    expect(args.join(' ')).not.toContain(hostile);
    expect(options.env?.AGENTDECK_LAUNCH_TARGET).toBe(hostile);
  });

  it('looks up Windows apps through Start Apps and keeps the name out of the script', async () => {
    const control = createSystemControl('win32', run);
    await control.openApp('Claude');

    const [executable, args, options] = run.mock.calls[0];
    expect(executable).toBe('powershell.exe');
    expect(args.at(-1)).toContain('Get-StartApps');
    expect(args.join(' ')).not.toContain('Claude');
    expect(options.env?.AGENTDECK_LAUNCH_TARGET).toBe('Claude');
  });

  it('falls back to the project page when AgentDeck has no Windows app', async () => {
    run.mockRejectedValueOnce(new Error('not installed')).mockResolvedValueOnce('');
    const control = createSystemControl('win32', run);

    await control.openAgentDeckAppOrGitHub();

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][2].env?.AGENTDECK_LAUNCH_TARGET)
      .toBe('https://puritysb.github.io/AgentDeck/');
  });

  it('coalesces rapid Windows volume ticks into one media-key process', async () => {
    vi.useFakeTimers();
    const control = createSystemControl('win32', run);

    control.changeOutputVolume(1, 51);
    control.changeOutputVolume(2, 53);
    await vi.advanceTimersByTimeAsync(100);

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][1].at(-1)).toContain('$i -lt 3');
    expect(run.mock.calls[0][1].at(-1)).toContain('[char]175');
  });

  it('uses the Windows mute media key and reports readback as unavailable', async () => {
    const control = createSystemControl('win32', run);

    await expect(control.getVolumeSettings()).rejects.toThrow('readback is unavailable');
    await control.setOutputMuted(true);

    expect(run.mock.calls[0][0]).toBe('powershell.exe');
    expect(run.mock.calls[0][1].at(-1)).toContain('[char]173');
  });
});
