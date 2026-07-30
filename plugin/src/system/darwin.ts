/**
 * macOS system control via osascript.
 * Uses execFile (no shell) for safety. This is also the fallback backend for
 * platforms the Stream Deck app does not exist on: there osascript/open reject
 * with ENOENT into the same catch paths the plugin already has.
 */
import { execFile } from 'child_process';
import type { SystemBackend, VolumeSettings } from './types.js';

// ---- Core executor ----

function osascript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { timeout: 5000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

// ---- Volume ----

async function getVolumeSettings(): Promise<VolumeSettings> {
  const raw = await osascript('get volume settings');
  // "output volume:65, input volume:80, alert volume:100, output muted:false"
  const num = (key: string): number | null => {
    const m = new RegExp(`${key}:(\\d+)`).exec(raw);
    return m ? parseInt(m[1], 10) : null;
  };
  return {
    outputVolume: num('output volume') ?? 0,
    outputMuted: /output muted:true/.test(raw),
  };
}

async function setVolumeNow(vol: number): Promise<void> {
  await osascript(`set volume output volume ${Math.round(vol)}`);
}

async function setOutputMuted(muted: boolean): Promise<void> {
  await osascript(`set volume output muted ${muted}`);
}

// ---- Browser Tab Focus ----

const CHROMIUM_BROWSERS = ['Google Chrome', 'Brave Browser', 'Microsoft Edge', 'Arc'] as const;
const SEARCHABLE_BROWSERS = [...CHROMIUM_BROWSERS, 'Safari'] as const;

/** Get list of searchable browsers currently running. */
async function getRunningBrowsers(): Promise<string[]> {
  const names = SEARCHABLE_BROWSERS.map(b => `"${b}"`).join(', ');
  try {
    const result = await osascript(
      `tell application "System Events" to get name of every process whose name is in {${names}}`,
    );
    if (!result) return [];
    return result.split(', ').filter(n => (SEARCHABLE_BROWSERS as readonly string[]).includes(n));
  } catch {
    return [];
  }
}

/** Try to focus an existing tab matching urlPrefix in the given browser. */
async function focusBrowserTab(browser: string, urlPrefix: string): Promise<boolean> {
  const escaped = urlPrefix.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const isChromium = (CHROMIUM_BROWSERS as readonly string[]).includes(browser);

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
    const result = await osascript(script);
    return result === 'found';
  } catch {
    return false;
  }
}

/**
 * Focus an existing browser tab matching urlPrefix, or open a new one.
 * Searches running Chromium browsers and Safari. Falls back to `open` command.
 */
async function openUrl(urlPrefix: string): Promise<void> {
  const browsers = await getRunningBrowsers();
  for (const browser of browsers) {
    const found = await focusBrowserTab(browser, urlPrefix);
    if (found) return;
  }
  // No existing tab found — open normally
  await new Promise<void>((resolve, reject) => {
    execFile('open', [urlPrefix], { timeout: 3000 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function openAgentDeckAppOrGitHub(): Promise<void> {
  const appOpened = await new Promise<boolean>((resolve) => {
    execFile('open', ['-a', 'AgentDeck'], { timeout: 3000 }, (err) => {
      resolve(!err);
    });
  });
  if (appOpened) return;
  await openUrl('https://puritysb.github.io/AgentDeck/');
}

// ---- App launch ----

/**
 * Launch or focus a desktop app by name (`open -a`).
 * Rejects when the app is not installed, so the caller can surface it.
 */
function openApp(appName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('open', ['-a', appName], { timeout: 5000 }, (err) => {
      if (err) reject(new Error(`Cannot open "${appName}": ${err.message}`));
      else resolve();
    });
  });
}

export const darwinBackend: SystemBackend = {
  isVolumeSupported: () => Promise.resolve(true),
  getVolumeSettings,
  setVolumeNow,
  setOutputMuted,
  openUrl,
  openApp,
  openAgentDeckAppOrGitHub,
};
