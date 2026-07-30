/**
 * Windows volume via a persistent PowerShell coprocess.
 *
 * Windows has no built-in CLI for absolute volume get/set. A per-call
 * `powershell -Command` would pay interpreter startup *plus* Add-Type C#
 * compilation on every 2s poll tick — hundreds of ms to seconds per read. So
 * one long-lived child compiles the CoreAudio interop once and then serves
 * requests over stdin/stdout in ~1ms.
 *
 * Protocol (line-based, one in-flight request at a time):
 *   requests:  GET | SET <0-100> | MUTE <0|1> | EXIT
 *   responses: OK <vol 0-100> <muted 0|1>   (post-state — SET/MUTE double as reads)
 *              ERR <message>
 * The script prints READY once Add-Type finishes, and its ReadLine loop exits
 * on stdin EOF — that self-exit is the load-bearing cleanup when Stream Deck
 * kills the plugin process (plugin.ts has no shutdown hook to dispose from).
 *
 * The script must be passed via -EncodedCommand: `-Command -` buffers stdin to
 * EOF before executing anything, which would deadlock an interactive child.
 */
import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import type { VolumeSettings } from './types.js';

/** First request covers spawn + Add-Type cold compile (1-3s, worse on first-ever run). */
const FIRST_REQUEST_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 2_000;
const MAX_STRIKES = 3;

/**
 * The C# is the well-known vtable-ordered CoreAudio interop. COM dispatches by
 * vtable slot, so the member ORDER inside each interface is correctness-critical
 * even for members we never call — do not reorder or remove the padding entries.
 * (No backticks and no "${" below — this file embeds the script in a TS template literal.)
 */
const SERVER_SCRIPT = `
$src = @'
using System;
using System.Runtime.InteropServices;

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int RegisterControlChangeNotify(IntPtr pNotify);
  int UnregisterControlChangeNotify(IntPtr pNotify);
  int GetChannelCount(out uint channelCount);
  int SetMasterVolumeLevel(float level, ref Guid eventContext);
  int SetMasterVolumeLevelScalar(float level, ref Guid eventContext);
  int GetMasterVolumeLevel(out float level);
  int GetMasterVolumeLevelScalar(out float level);
  int SetChannelVolumeLevel(uint channelNumber, float level, ref Guid eventContext);
  int SetChannelVolumeLevelScalar(uint channelNumber, float level, ref Guid eventContext);
  int GetChannelVolumeLevel(uint channelNumber, out float level);
  int GetChannelVolumeLevelScalar(uint channelNumber, out float level);
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool isMuted, ref Guid eventContext);
  int GetMute(out bool isMuted);
  int GetVolumeStepInfo(out uint step, out uint stepCount);
  int VolumeStepUp(ref Guid eventContext);
  int VolumeStepDown(ref Guid eventContext);
  int QueryHardwareSupport(out uint hardwareSupportMask);
  int GetVolumeRange(out float volumeMin, out float volumeMax, out float volumeStep);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object endpointVolume);
}

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumeratorComObject { }

public class Audio {
  static IAudioEndpointVolume Vol() {
    var enumerator = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
    IMMDevice dev;
    Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out dev));
    var iid = typeof(IAudioEndpointVolume).GUID;
    object o;
    Marshal.ThrowExceptionForHR(dev.Activate(ref iid, 23, IntPtr.Zero, out o));
    return (IAudioEndpointVolume)o;
  }
  public static int GetVolume() {
    float v;
    Marshal.ThrowExceptionForHR(Vol().GetMasterVolumeLevelScalar(out v));
    return (int)Math.Round(v * 100);
  }
  public static int GetMute() {
    bool m;
    Marshal.ThrowExceptionForHR(Vol().GetMute(out m));
    return m ? 1 : 0;
  }
  public static void SetVolume(int v) {
    var ctx = Guid.Empty;
    Marshal.ThrowExceptionForHR(Vol().SetMasterVolumeLevelScalar(v / 100f, ref ctx));
  }
  public static void SetMute(int m) {
    var ctx = Guid.Empty;
    Marshal.ThrowExceptionForHR(Vol().SetMute(m != 0, ref ctx));
  }
}
'@
try {
  Add-Type -TypeDefinition $src -ErrorAction Stop | Out-Null
} catch {
  [Console]::Out.WriteLine('ERR AddType: ' + $_.Exception.Message.Replace([char]13, ' ').Replace([char]10, ' '))
  exit 1
}
[Console]::Out.WriteLine('READY')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line -or $line -eq 'EXIT') { break }
  try {
    $p = $line.Split(' ')
    switch ($p[0]) {
      'GET'  { }
      'SET'  { [Audio]::SetVolume([int]$p[1]) }
      'MUTE' { [Audio]::SetMute([int]$p[1]) }
      default { throw ('unknown command: ' + $p[0]) }
    }
    [Console]::Out.WriteLine('OK ' + [Audio]::GetVolume() + ' ' + [Audio]::GetMute())
  } catch {
    [Console]::Out.WriteLine('ERR ' + $_.Exception.Message.Replace([char]13, ' ').Replace([char]10, ' '))
  }
}
`;

type RequestKind = 'GET' | 'SET' | 'MUTE';

interface Pending {
  kind: RequestKind;
  line: string;
  resolve: (v: VolumeSettings) => void;
  reject: (e: Error) => void;
}

export class WinVolumeCoprocess {
  private proc: ChildProcess | null = null;
  private ready = false;
  /** Whether the CURRENT child has served at least one successful OK. */
  private served = false;
  private strikes = 0;
  private unsupported = false;
  private inflight: Pending | null = null;
  private queue: Pending[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private buf = '';

  constructor() {
    // Best-effort tidiness only — the PS ReadLine loop's stdin-EOF self-exit is
    // what actually guarantees no orphan when this process dies uncleanly.
    process.on('exit', () => this.dispose());
  }

  isSupported(): boolean {
    return !this.unsupported;
  }

  get(): Promise<VolumeSettings> {
    return this.request('GET', 'GET');
  }

  set(vol: number): Promise<VolumeSettings> {
    return this.request('SET', `SET ${Math.round(vol)}`);
  }

  mute(muted: boolean): Promise<VolumeSettings> {
    return this.request('MUTE', `MUTE ${muted ? 1 : 0}`);
  }

  private request(kind: RequestKind, line: string): Promise<VolumeSettings> {
    if (this.unsupported) {
      return Promise.reject(new Error('volume control unavailable (PowerShell CoreAudio helper failed)'));
    }
    return new Promise<VolumeSettings>((resolve, reject) => {
      const pending: Pending = { kind, line, resolve, reject };
      // Coalesce: only the final SET (and final MUTE) matters, mirroring the
      // dial-rotation debounce — so the queue is bounded even while the child
      // hangs through the 15s first-request window. GETs are already bounded
      // to one by utility-dial's `polling` re-entrancy guard.
      if (kind !== 'GET') {
        const i = this.queue.findIndex(q => q.kind === kind);
        if (i !== -1) {
          const superseded = this.queue[i];
          this.queue[i] = pending;
          superseded.reject(new Error('superseded'));
          this.pump();
          return;
        }
      }
      this.queue.push(pending);
      this.pump();
    });
  }

  private pump(): void {
    if (this.inflight || this.queue.length === 0 || this.unsupported) return;
    if (!this.proc) {
      this.spawnChild();
      // A synchronous spawn failure already rejected the queue via onChildGone.
      if (!this.proc) return;
    }
    this.inflight = this.queue.shift()!;
    this.armTimer();
    if (this.ready) this.writeInflight();
    // else: written when READY arrives
  }

  private writeInflight(): void {
    if (!this.inflight || !this.proc?.stdin?.writable) return;
    try {
      this.proc.stdin.write(`${this.inflight.line}\n`);
    } catch {
      // exit handler will reject and account for it
    }
  }

  private armTimer(): void {
    this.clearTimer();
    const ms = this.served ? REQUEST_TIMEOUT_MS : FIRST_REQUEST_TIMEOUT_MS;
    this.timer = setTimeout(() => {
      // A hung child. Don't rely on kill() → 'exit' to do the accounting: a
      // child whose spawn failed asynchronously (ENOENT fires 'error' but
      // never 'exit') is un-killable and would leave the request hanging.
      // Account deterministically here; the eventual 'exit' event (if any) is
      // then a no-op because onChildGone already nulled this.proc.
      const proc = this.proc;
      proc?.kill();
      if (this.proc === proc) {
        this.onChildGone(new Error('volume helper timed out'));
      }
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private spawnChild(): void {
    const powershell = path.join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
    );
    const encoded = Buffer.from(SERVER_SCRIPT, 'utf16le').toString('base64');
    this.ready = false;
    this.served = false;
    this.buf = '';
    let proc: ChildProcess;
    try {
      proc = spawn(powershell, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', encoded,
      ], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    } catch (err) {
      this.onChildGone(new Error(`spawn failed: ${err}`));
      return;
    }
    this.proc = proc;
    // Writing to a dying child's stdin surfaces as an ASYNC 'error' event
    // (EPIPE) that try/catch around write() cannot see — without a listener it
    // would crash the whole plugin process. The 'exit' handler already does
    // the accounting, so swallowing here is correct, not lossy.
    proc.stdin?.on('error', () => {});
    proc.stdout?.on('error', () => {});
    proc.stdout?.setEncoding('utf8');
    // Every handler is guarded by `this.proc === proc`: a killed-but-draining
    // zombie child may still deliver buffered stdout after a replacement was
    // spawned, and without the guard that stale OK could resolve the NEW
    // child's in-flight request.
    proc.stdout?.on('data', (chunk: string) => {
      if (this.proc === proc) this.onData(chunk);
    });
    // 'error' (e.g. spawn ENOENT) may fire WITHOUT a following 'exit', so it
    // must do the full accounting itself — whichever of error/exit fires first
    // wins and the other no-ops.
    proc.on('error', () => {
      if (this.proc === proc) this.onChildGone(new Error('volume helper failed to start'));
    });
    proc.on('exit', () => {
      if (this.proc === proc) this.onChildGone(new Error('volume helper exited'));
    });
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    if (line === 'READY') {
      this.ready = true;
      this.writeInflight();
      return;
    }
    const pending = this.inflight;
    if (!pending) return; // unsolicited — ignore
    if (line.startsWith('OK ')) {
      const parts = line.split(' ');
      const vol = parseInt(parts[1], 10);
      const muted = parts[2] === '1';
      this.inflight = null;
      this.clearTimer();
      this.served = true;
      this.strikes = 0;
      pending.resolve({ outputVolume: Number.isFinite(vol) ? vol : 0, outputMuted: muted });
      this.pump();
      return;
    }
    // ERR — the child is alive and speaking protocol; reject just this request.
    this.inflight = null;
    this.clearTimer();
    pending.reject(new Error(line.startsWith('ERR') ? line : `unexpected reply: ${line}`));
    this.pump();
  }

  /** Child exited or failed to spawn: reject everything pending, count strikes. */
  private onChildGone(cause: Error): void {
    this.clearTimer();
    this.proc = null;
    this.ready = false;
    if (!this.served) {
      // Strike = a child that died (any cause, including our timeout kill)
      // without ever serving one OK. A child that served and later died just
      // respawns lazily on the next request.
      this.strikes += 1;
      if (this.strikes >= MAX_STRIKES) this.unsupported = true;
    }
    const err = this.unsupported
      ? new Error('volume control unavailable (PowerShell CoreAudio helper failed)')
      : cause;
    const pending = this.inflight ? [this.inflight, ...this.queue] : [...this.queue];
    this.inflight = null;
    this.queue = [];
    for (const p of pending) p.reject(err);
  }

  /** Synchronous on purpose — runs inside process.on('exit'). */
  dispose(): void {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    try { proc.stdin?.write('EXIT\n'); } catch { /* already gone */ }
    try { proc.kill(); } catch { /* already gone */ }
  }
}
