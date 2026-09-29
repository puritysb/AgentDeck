/**
 * Typed facade over the vendored UlanziDeckPlugin-SDK (common-node) `UlanziApi`.
 * The SDK is plain ESM JS (Apache-2.0, vendored under src/vendor/ulanzi-api);
 * this module gives us the method/event surface we actually use, typed.
 *
 * `context` is the SDK's per-key instance id: `uuid___key___actionid`.
 */
import UlanziApiRaw from './vendor/ulanzi-api/index.js';

export interface UlanziMessage {
  context: string;
  uuid: string;
  key: string;
  actionid: string;
  active?: boolean;
  param?: Record<string, unknown> | null;
  [k: string]: unknown;
}

export interface UlanziApi {
  /** address/port are overridden by process.argv[2..] that Ulanzi Studio passes. */
  connect(uuid: string, port?: number, address?: string): void;
  onConnected(fn: (d: unknown) => void): UlanziApi;
  onClose(fn: () => void): UlanziApi;
  onError(fn: (e: string) => void): UlanziApi;
  onAdd(fn: (m: UlanziMessage) => void): UlanziApi;
  onClear(fn: (m: UlanziMessage) => void): UlanziApi;
  onSetActive(fn: (m: UlanziMessage) => void): UlanziApi;
  onRun(fn: (m: UlanziMessage) => void): UlanziApi;
  onKeyDown(fn: (m: UlanziMessage) => void): UlanziApi;
  onKeyUp(fn: (m: UlanziMessage) => void): UlanziApi;
  /** type 1 — custom base64 PNG (no data: prefix). `text` shows below the icon. */
  setBaseDataIcon(context: string, base64Png: string, text?: string): void;
  /** type 3 — custom base64 GIF for animation. */
  setGifDataIcon(context: string, base64Gif: string, text?: string): void;
  setStateIcon(context: string, state: number, text?: string): void;
  setPathIcon(context: string, path: string, text?: string): void;
  onDidReceiveGlobalSettings(fn: (m: UlanziMessage) => void): UlanziApi;
  getGlobalSettings(): void;
  setGlobalSettings(settings: unknown): void;
  setSettings(settings: unknown, context?: string): void;
  getSettings(context?: string): void;
  /** Raw protocol send — used to batch many key images in one `state` message. */
  send(cmd: string, params: Record<string, unknown>): void;
  decodeContext(context: string): { uuid: string; key: string; actionid: string };
  emit(event: string, ...args: unknown[]): boolean;
}

/** One key's image in a batched `state` push. */
export interface IconBatchItem {
  context: string;
  /** base64 PNG (no prefix). Mutually exclusive with `gif`. */
  png?: string;
  /** base64 GIF (no prefix). */
  gif?: string;
}

export const UlanziApiCtor = UlanziApiRaw as unknown as { new (): UlanziApi };
