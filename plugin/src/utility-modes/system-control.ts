/**
 * Host system controls used by Stream Deck actions.
 *
 * macOS uses osascript/open. Windows uses the built-in Windows PowerShell
 * available on every supported Windows 10/11 host. User-controlled launch
 * targets travel through an environment variable rather than being interpolated
 * into a command string.
 */
import { execFile } from 'child_process';

export interface VolumeSettings {
  outputVolume: number;
  outputMuted: boolean;
}

interface RunOptions {
  timeout: number;
  env?: NodeJS.ProcessEnv;
}

export type ProcessRunner = (
  executable: string,
  args: string[],
  options: RunOptions,
) => Promise<string>;

function defaultRunner(executable: string, args: string[], options: RunOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, options, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

const POWERSHELL_ARGS = [
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-Command',
] as const;

function withLaunchTarget(value: string): NodeJS.ProcessEnv {
  return { ...process.env, AGENTDECK_LAUNCH_TARGET: value };
}

export function createSystemControl(
  platform: NodeJS.Platform = process.platform,
  run: ProcessRunner = defaultRunner,
) {
  const isMac = platform === 'darwin';
  const isWindows = platform === 'win32';
  const debounceMap = new Map<string, ReturnType<typeof setTimeout>>();
  let pendingWindowsVolumeTicks = 0;

  function unsupported(): Error {
    return new Error(`Unsupported Stream Deck host platform: ${platform}`);
  }

  function osascript(script: string): Promise<string> {
    if (!isMac) return Promise.reject(unsupported());
    return run('osascript', ['-e', script], { timeout: 5000 });
  }

  function powershell(script: string, env?: NodeJS.ProcessEnv): Promise<string> {
    if (!isWindows) return Promise.reject(unsupported());
    return run('powershell.exe', [...POWERSHELL_ARGS, script], {
      timeout: 5000,
      ...(env ? { env } : {}),
    });
  }

  function debounced(key: string, operation: () => Promise<unknown>, delayMs = 100): void {
    const existing = debounceMap.get(key);
    if (existing) clearTimeout(existing);
    debounceMap.set(key, setTimeout(() => {
      debounceMap.delete(key);
      void operation().catch(() => {});
    }, delayMs));
  }

  async function getVolumeSettings(): Promise<VolumeSettings> {
    if (!isMac) {
      throw new Error('Volume readback is unavailable on this platform');
    }
    const raw = await osascript('get volume settings');
    const num = (key: string): number | null => {
      const match = new RegExp(`${key}:(\\d+)`).exec(raw);
      return match ? parseInt(match[1], 10) : null;
    };
    return {
      outputVolume: num('output volume') ?? 0,
      outputMuted: /output muted:true/.test(raw),
    };
  }

  /**
   * Apply a dial delta. macOS receives the absolute target so it can preserve
   * exact 1% steps; Windows emits the matching media keys and coalesces rapid
   * rotations into one PowerShell process.
   */
  function changeOutputVolume(delta: number, absoluteTarget: number): void {
    if (isMac) {
      debounced('output-volume', () =>
        osascript(`set volume output volume ${Math.round(absoluteTarget)}`));
      return;
    }
    if (!isWindows) return;

    pendingWindowsVolumeTicks += Math.trunc(delta);
    debounced('output-volume', async () => {
      const ticks = pendingWindowsVolumeTicks;
      pendingWindowsVolumeTicks = 0;
      if (ticks === 0) return;
      const count = Math.min(Math.abs(ticks), 100);
      const keyCode = ticks > 0 ? 175 : 174; // VK_VOLUME_UP / VK_VOLUME_DOWN
      await powershell(
        `$shell = New-Object -ComObject WScript.Shell; for ($i = 0; $i -lt ${count}; $i++) { $shell.SendKeys([char]${keyCode}) }`,
      );
    });
  }

  /** Rejects on failure so the action can surface showAlert(). */
  function setOutputMuted(muted: boolean): Promise<string> {
    if (isMac) return osascript(`set volume output muted ${muted}`);
    if (isWindows) {
      // Windows exposes a toggle media key rather than an absolute mute setter.
      return powershell(
        '$shell = New-Object -ComObject WScript.Shell; $shell.SendKeys([char]173)',
      );
    }
    return Promise.reject(unsupported());
  }

  const chromiumBrowsers = ['Google Chrome', 'Brave Browser', 'Microsoft Edge', 'Arc'] as const;
  const searchableBrowsers = [...chromiumBrowsers, 'Safari'] as const;

  async function getRunningBrowsers(): Promise<string[]> {
    if (!isMac) return [];
    const names = searchableBrowsers.map(browser => `"${browser}"`).join(', ');
    try {
      const result = await osascript(
        `tell application "System Events" to get name of every process whose name is in {${names}}`,
      );
      if (!result) return [];
      return result.split(', ').filter(name =>
        (searchableBrowsers as readonly string[]).includes(name));
    } catch {
      return [];
    }
  }

  async function focusBrowserTab(browser: string, urlPrefix: string): Promise<boolean> {
    if (!isMac) return false;
    const escaped = urlPrefix.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const isChromium = (chromiumBrowsers as readonly string[]).includes(browser);
    const script = isChromium
      ? `tell application "${browser}"
  set wIndex to 0
  repeat with w in windows
    set wIndex to wIndex + 1
    set tIndex to 0
    repeat with t in tabs of w
      set tIndex to tIndex + 1
      if URL of t starts with "${escaped}" then
        set active tab index of w to tIndex
        set index of w to 1
        activate
        return "found"
      end if
    end repeat
  end repeat
end tell
return "notfound"`
      : `tell application "Safari"
  set wIndex to 0
  repeat with w in windows
    set wIndex to wIndex + 1
    set tIndex to 0
    repeat with t in tabs of w
      set tIndex to tIndex + 1
      if URL of t starts with "${escaped}" then
        set current tab of w to t
        set index of w to 1
        activate
        return "found"
      end if
    end repeat
  end repeat
end tell
return "notfound"`;
    try {
      return await osascript(script) === 'found';
    } catch {
      return false;
    }
  }

  async function openOrFocusBrowserTab(urlPrefix: string): Promise<void> {
    if (isWindows) {
      await powershell(
        'Start-Process -FilePath $env:AGENTDECK_LAUNCH_TARGET',
        withLaunchTarget(urlPrefix),
      );
      return;
    }
    if (!isMac) throw unsupported();

    const browsers = await getRunningBrowsers();
    for (const browser of browsers) {
      if (await focusBrowserTab(browser, urlPrefix)) return;
    }
    await run('open', [urlPrefix], { timeout: 3000 });
  }

  async function openApp(appName: string): Promise<void> {
    if (isMac) {
      try {
        await run('open', ['-a', appName], { timeout: 5000 });
      } catch (err) {
        throw new Error(`Cannot open "${appName}": ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    if (isWindows) {
      try {
        await powershell(
          '$app = Get-StartApps | Where-Object { $_.Name -eq $env:AGENTDECK_LAUNCH_TARGET } | Select-Object -First 1; if (-not $app) { exit 2 }; Start-Process -FilePath ("shell:AppsFolder\\" + $app.AppID)',
          withLaunchTarget(appName),
        );
      } catch (err) {
        throw new Error(`Cannot open "${appName}": ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    throw unsupported();
  }

  async function openAgentDeckAppOrGitHub(): Promise<void> {
    try {
      await openApp('AgentDeck');
      return;
    } catch {
      await openOrFocusBrowserTab('https://puritysb.github.io/AgentDeck/');
    }
  }

  return {
    supportsVolumeReadback: isMac,
    getVolumeSettings,
    changeOutputVolume,
    setOutputMuted,
    openOrFocusBrowserTab,
    openAgentDeckAppOrGitHub,
    openApp,
  };
}

const systemControl = createSystemControl();

export const supportsVolumeReadback = systemControl.supportsVolumeReadback;
export const getVolumeSettings = systemControl.getVolumeSettings;
export const changeOutputVolume = systemControl.changeOutputVolume;
export const setOutputMuted = systemControl.setOutputMuted;
export const openOrFocusBrowserTab = systemControl.openOrFocusBrowserTab;
export const openAgentDeckAppOrGitHub = systemControl.openAgentDeckAppOrGitHub;
export const openApp = systemControl.openApp;
