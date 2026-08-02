/**
 * Contract every platform backend implements. The facade in `index.ts` picks
 * one per `process.platform` and re-exports the historical function names, so
 * action modules never know which platform they run on.
 */

export interface VolumeSettings {
  outputVolume: number;
  outputMuted: boolean;
}

export interface SystemBackend {
  /**
   * Whether volume control can work here. Cheap and side-effect free: it never
   * spawns anything, it only reports state (e.g. the Windows coprocess breaker).
   * `false` puts the E1 dial into its N/A face instead of polling forever.
   */
  isVolumeSupported(): Promise<boolean>;
  getVolumeSettings(): Promise<VolumeSettings>;
  /** Immediate volume set — the facade owns the dial-rotation debounce. */
  setVolumeNow(vol: number): Promise<void>;
  /** Rejects on failure so the caller can surface it (showAlert) — see utility-dial. */
  setOutputMuted(muted: boolean): Promise<void>;
  /**
   * Open a URL in the default browser. The darwin backend first tries to focus
   * an existing tab (osascript); other platforms just open a fresh tab.
   */
  openUrl(urlPrefix: string): Promise<void>;
  /** Launch or focus a desktop app by name. Rejects when the app is not installed. */
  openApp(appName: string): Promise<void>;
  /** Offline fallback for every encoder press: desktop app if any, else the project page. */
  openAgentDeckAppOrGitHub(): Promise<void>;
}
