/**
 * `agentdeck esp32 flash <board>` — the reliable half of the firmware install
 * story. (The browser flasher at /flash/ is the reachable half.)
 *
 * WHAT IT WRITES. One `agentdeck-<board>-merged.bin` at offset 0x0, on every
 * chip. `esptool merge-bin --target-offset 0x0` has already put each board's
 * bootloader where its ROM looks for it — classic ESP32 at 0x1000 inside the
 * image, P4 at 0x2000, S3/C6 at 0x0 — so nothing downstream branches on chip
 * family. The old release notes told users to write the app alone at 0x10000,
 * which cannot bring a board up: `boot_app0.bin` was never published, so a
 * stale otadata boots the previous slot.
 *
 * WHAT IT WILL NOT WRITE. The preflight in `@agentdeck/shared` is shared
 * verbatim with the browser, and there is no `--force`. Writing an S3 image to
 * a classic ESP32, or a 16MB-header image to an 8MB part, is how these boards
 * get bricked — and the recovery tool for a bricked board is this one.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ESPLoader, Transport } from './esptool-js-node.js';
import {
  ESP32_BOARD_BY_TARGET,
  esp32FlashIdIsUsable,
  esp32PostWriteResetSequence,
  esp32PreflightVerdict,
  type Esp32BoardSpec,
  type Esp32PreflightVerdict,
} from '@agentdeck/shared';
import { getDataDir } from './session-registry.js';
import { listCandidatePorts, loadSerialPort, NodeWebSerialPort } from './esp32-flash-transport.js';

const execFileAsync = promisify(execFile);

export const GITHUB_REPO = 'puritysb/AgentDeck';

/* ------------------------------------------------------------ board lookup */

export function resolveFlashBoard(target: string): Esp32BoardSpec {
  const board = ESP32_BOARD_BY_TARGET[target];
  if (!board) {
    const known = Object.keys(ESP32_BOARD_BY_TARGET).sort().join(', ');
    throw new Error(`unknown board "${target}". Known targets: ${known}`);
  }
  return board;
}

/* --------------------------------------------------------- release manifest
 * The CLI reads the manifest from the RELEASE, not from Pages. It is not in a
 * browser so CORS is irrelevant, and Pages can lag a firmware cut by a whole
 * master push — reading the release is both simpler and more current.
 */

export interface ManifestArtifact { file: string; size: number; sha256: string; offset: string }
export interface ManifestBoardEntry {
  id: string;
  chipFamily: string;
  flashSize: string;
  flashMode: string;
  flashFreq: string;
  uploadBaud: number;
  merged?: ManifestArtifact;
}
export interface ReleaseManifest {
  schema: number;
  release: string;
  firmwareVersion: string;
  boards: ManifestBoardEntry[];
}

const api = async (path: string): Promise<unknown> => {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'agentdeck-cli' },
  });
  if (!res.ok) throw new Error(`GitHub API ${path} → HTTP ${res.status}`);
  return res.json();
};

/**
 * Every published `esp32-v*` tag, newest first.
 *
 * PAGED, because a single page is a silent cap. `per_page` maxes at 100 and
 * this repo cuts ~6 tags a round across its channels, so once ~100 releases
 * accumulate after the newest esp32 cut, one page stops containing it — and the
 * damage is not "no answer" but a WRONG one: the existence check would report a
 * genuinely published version as unpublished and quietly fall back to an older
 * release. Stops at the first page that yields no esp32 tag once some are
 * already known, so the common case is still one request.
 */
export async function listFirmwareTags(maxPages = 5): Promise<string[]> {
  const found: Array<{ tag: string; at: string }> = [];
  for (let page = 1; page <= maxPages; page++) {
    const releases = (await api(`/repos/${GITHUB_REPO}/releases?per_page=100&page=${page}`)) as Array<{
      tag_name?: string;
      created_at?: string;
    }>;
    if (releases.length === 0) break;
    const esp32 = releases.filter(
      (r) => typeof r.tag_name === 'string' && r.tag_name.startsWith('esp32-v'),
    );
    found.push(...esp32.map((r) => ({ tag: r.tag_name as string, at: String(r.created_at) })));
    // Releases come back newest-first, so once this page has none and we
    // already have some, everything older is older still.
    if (esp32.length === 0 && found.length > 0) break;
    if (releases.length < 100) break;
  }
  return found.sort((a, b) => (a.at < b.at ? 1 : -1)).map((r) => r.tag);
}

/** Newest `esp32-v*` tag, or undefined when the repo has none. */
export async function latestFirmwareTag(): Promise<string | undefined> {
  return (await listFirmwareTags())[0];
}

/**
 * Which release a bare `agentdeck esp32 flash <board>` takes firmware from.
 *
 * TWO RULES, IN THIS ORDER, AND NEITHER WORKS ALONE. The checkout's
 * `FIRMWARE_VERSION` names the release this source tree belongs to — but it is
 * bumped BEFORE the tag is pushed, so during that window it names a release
 * that does not exist yet. Taking it unconditionally is how the first command
 * in the docs came to fail from every checkout the moment the version was
 * bumped (and the 404 it produced was indistinguishable from "this release has
 * no manifest", so it also misdiagnosed itself).
 *
 * Deliberately the same shape as `resolveTag` in
 * `scripts/fetch-flash-firmware.mjs`. That one runs in CI with `gh`; this one
 * runs on a user's machine with `fetch`. Same rules, same reported `source`.
 */
export function pickFirmwareTag(
  configVersion: string | undefined,
  published: readonly string[],
): { tag: string; source: 'config' | 'latest' } {
  if (configVersion) {
    const candidate = `esp32-v${configVersion}`;
    if (published.includes(candidate)) return { tag: candidate, source: 'config' };
  }
  const latest = published[0];
  if (!latest) throw new Error(`no esp32-v* release found in ${GITHUB_REPO}`);
  return { tag: latest, source: 'latest' };
}

export function firmwareVersionFromCheckout(configH: string): string | undefined {
  const m = /FIRMWARE_VERSION\s*=\s*"([^"]+)"/.exec(configH);
  return m?.[1];
}

export function firmwareCacheDir(tag: string): string {
  return join(getDataDir(), 'firmware', tag);
}

const sha256 = (buf: Buffer | Uint8Array): string =>
  createHash('sha256').update(buf).digest('hex');

async function downloadAsset(tag: string, file: string, dest: string): Promise<void> {
  const url = `https://github.com/${GITHUB_REPO}/releases/download/${tag}/${file}`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${file} → HTTP ${res.status} (${url})`);
  const bytes = Buffer.from(await res.arrayBuffer());
  mkdirSync(join(dest, '..'), { recursive: true });
  const tmp = `${dest}.tmp`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, dest);
}

export interface ResolveFirmwareOptions {
  tag?: string;
  /** an explicit .bin — skips the download entirely, mirroring esp32-ota's -f */
  firmwarePath?: string;
  /** fail instead of reaching the network */
  offline?: boolean;
  /** the repo checkout's esp32/src/config.h, when running from a checkout */
  checkoutConfigH?: string;
  log?: (msg: string) => void;
}

export interface ResolvedFirmware {
  tag: string;
  image: Buffer;
  /** the manifest entry, when one was used; absent for --firmware */
  entry?: ManifestBoardEntry;
  source: 'file' | 'cache' | 'download';
  path?: string;
}

/**
 * Get the merged image for a board, verifying its sha256 EVERY time — on a
 * fresh download and on every cache hit. The cache key proves which release a
 * file came from, never that its bits are still intact, and a bit-rotted cached
 * image is a bricked board.
 */
export async function resolveFirmware(
  board: Esp32BoardSpec,
  opts: ResolveFirmwareOptions = {},
): Promise<ResolvedFirmware> {
  const log = opts.log ?? (() => {});

  if (opts.firmwarePath) {
    if (!existsSync(opts.firmwarePath)) throw new Error(`no such firmware file: ${opts.firmwarePath}`);
    // An explicit path is the user overriding the manifest, so there is no hash
    // to check against — say so rather than implying it was verified.
    log(`Using ${opts.firmwarePath} (no manifest hash to check against)`);
    return {
      tag: 'local',
      image: readFileSync(opts.firmwarePath),
      source: 'file',
      path: opts.firmwarePath,
    };
  }

  let tag = opts.tag;
  const configVersion = opts.checkoutConfigH
    ? firmwareVersionFromCheckout(opts.checkoutConfigH)
    : undefined;
  if (!tag && opts.offline) {
    // Offline cannot ask which releases exist, so it cannot apply rule 2's
    // existence check. The checkout's own version is a LOCAL fact though, and
    // using it is the whole point of an offline run against a warm cache — so
    // take it optimistically here and let the cache lookup below produce the
    // error if nothing was cached for it.
    if (!configVersion) throw new Error('--offline needs --tag or --firmware; nothing to resolve');
    tag = `esp32-v${configVersion}`;
  }
  if (!tag) {
    // One API call answers both rules: is the checkout's version published, and
    // what is the newest release. Checking existence is the whole point — see
    // pickFirmwareTag.
    const picked = pickFirmwareTag(configVersion, await listFirmwareTags());
    tag = picked.tag;
    log(
      `Firmware release: ${tag} (${
        picked.source === 'config'
          ? "this checkout's esp32/src/config.h"
          : 'newest published esp32-v* release'
      })`,
    );
  }

  const dir = firmwareCacheDir(tag);
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    if (opts.offline) throw new Error(`--offline: no cached manifest for ${tag} at ${manifestPath}`);
    log(`Fetching manifest for ${tag}…`);
    try {
      await downloadAsset(tag, 'manifest.json', manifestPath);
    } catch (e) {
      // A 404 here is not a network fault — every esp32-v* up to 1.0.6 predates
      // the merged-image pipeline and publishes no manifest at all. Saying so
      // points at the fix; "HTTP 404" points at nothing.
      if (/HTTP 404/.test(String(e))) {
        // Reached only after the tag was confirmed to exist (pickFirmwareTag
        // checks the published list), so this is specifically "that release has
        // no manifest", never "no such release" — the two produce identical
        // 404s and conflating them misdiagnoses both.
        throw new Error(
          `${tag} publishes no manifest.json — it predates the merged-image pipeline.\n` +
            '  Every release up to esp32-v1.0.6 is in that state. Either cut a newer\n' +
            '  esp32-v* release, pass --tag once one exists, or pass --firmware with a\n' +
            '  locally built image.',
        );
      }
      throw e;
    }
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ReleaseManifest;
  const entry = manifest.boards.find((b) => b.id === board.id);
  if (!entry?.merged) {
    throw new Error(
      `${tag} publishes no merged image for ${board.id}. ` +
        'Releases before the merged-image pipeline have none — use a newer --tag, or --firmware.',
    );
  }

  const imagePath = join(dir, entry.merged.file);
  let source: ResolvedFirmware['source'] = 'cache';
  if (!existsSync(imagePath) || sha256(readFileSync(imagePath)) !== entry.merged.sha256) {
    if (opts.offline) throw new Error(`--offline: ${entry.merged.file} is not cached (or failed its hash)`);
    log(`Downloading ${entry.merged.file} (${(entry.merged.size / 1e6).toFixed(1)} MB)…`);
    await downloadAsset(tag, entry.merged.file, imagePath);
    source = 'download';
  }

  const image = readFileSync(imagePath);
  const got = sha256(image);
  if (got !== entry.merged.sha256) {
    throw new Error(
      `${entry.merged.file}: sha256 ${got} ≠ manifest ${entry.merged.sha256}. Refusing to write unverified bits.`,
    );
  }
  if (image.length !== entry.merged.size) {
    throw new Error(`${entry.merged.file}: ${image.length} bytes, manifest says ${entry.merged.size}`);
  }
  return { tag, image, entry, source, path: imagePath };
}

/* --------------------------------------------------------------- port state
 * `lsof` is the CLI's answer to the one thing the browser flasher genuinely
 * cannot do. The lease stops the NODE daemon, but the sandboxed Swift daemon
 * cannot read `~/.agentdeck`, so "I asked it to stand down" is not evidence
 * the port is free. Looking is.
 */

export interface PortHolder { command: string; pid: number }

/* ------------------------------------------------- daemon suspend sweep (#327)
 * The 2026-09-13 incident, in one line each: the Node daemon went
 * latency-silent at host load 600–800; the macOS app promoted a fallback
 * daemon on 9121 whose serial poll DTR-reset the board mid-write; and the
 * flash CLI's single suspend call timed out against the blocked Node daemon
 * and was read as "no daemon", so it never reached the daemon that actually
 * held the port. The sweep asks EVERY daemon in the port window and refuses
 * to distinguish "nothing there" from "there and silent" — the listener's
 * identity, not its silence, decides.
 */

export type SuspendSweepOutcome =
  | { kind: 'suspended'; port: number }
  | { kind: 'nothing'; port: number }
  | { kind: 'foreign-listener'; port: number }
  | { kind: 'not-a-daemon'; port: number }
  | { kind: 'unreachable'; port: number; listener: string }
  | { kind: 'refused'; port: number; detail: string };

export interface SuspendSweepDeps {
  /** POST /esp32/serial/suspend — the transport wrapper, injectable for tests. */
  postSuspend: (port: number) => Promise<{ ok: boolean; statusCode: number | null; errCode: string | null }>;
  /** GET /health, already resolved by the caller (session-registry). */
  probeDaemonHealth: (port: number) => Promise<{ mode?: string } | null>;
  scanTcpListener: (port: number) => Promise<PortHolderScan>;
}

export interface SuspendSweepResult {
  /** Ports whose daemons acknowledged the suspension (and must be resumed). */
  suspendedPorts: number[];
  /** Human lines for the command's log — the caller owns printing. */
  notices: string[];
  /** Set when the flash must not proceed; the message is user-ready. */
  refuse?: string;
}

/**
 * Suspend every AgentDeck daemon in `ports` (the port window) and classify
 * each answer. Pure policy over injectable probes, so the #327 truth table —
 * silence from an AgentDeck listener refuses, silence from anyone else does
 * not, a daemon that answers-but-declines refuses, a session bridge's 404 is
 * not a serial holder — is unit-pinnable without hardware.
 */
export async function sweepAndSuspendDaemons(
  ports: number[],
  leaseSeconds: number,
  deps: SuspendSweepDeps,
): Promise<SuspendSweepResult> {
  const outcomes: SuspendSweepOutcome[] = await Promise.all(ports.map(async (port): Promise<SuspendSweepOutcome> => {
    const call = await deps.postSuspend(port);
    if (call.ok) return { kind: 'suspended', port };
    if (call.statusCode !== null) {
      // Answered, but not a suspend success (404 from a session bridge or a
      // pre-parity Swift daemon, 401 auth refusal…). Which one decides
      // danger: an AgentDeck DAEMON answering anything is a serial owner that
      // would not stand down; a session bridge holds no serial.
      const health = await deps.probeDaemonHealth(port);
      if (health?.mode === 'daemon') {
        return { kind: 'refused', port, detail: `daemon on :${port} answered HTTP ${call.statusCode} to suspend` };
      }
      return { kind: 'not-a-daemon', port };
    }
    // No answer at all. ECONNREFUSED is the one transport error that means
    // "no listener" — a timeout or a reset means something is there, and WHO
    // is listening decides: an AgentDeck process that cannot be reached
    // cannot be asked to let go, and its 10 s serial poll may still fire
    // mid-write. Anything else squatting a TCP port is not a serial threat.
    if (call.errCode === 'ECONNREFUSED') return { kind: 'nothing', port };
    const listenerScan = await deps.scanTcpListener(port);
    if (listenerScan.known && listenerScan.holders.length > 0) {
      if (classifyHolders(listenerScan.holders).ours.length > 0) {
        return {
          kind: 'unreachable', port,
          listener: listenerScan.holders.map((h) => `${h.command}(${h.pid})`).join(', '),
        };
      }
      // Silent, but not ours — a foreign process squatting a TCP port is not
      // a serial threat, and must not launder into "no daemon is listening".
      return { kind: 'foreign-listener', port };
    }
    return { kind: 'nothing', port };
  }));

  const suspendedPorts = outcomes.filter((o) => o.kind === 'suspended').map((o) => o.port);
  const refused = outcomes.filter((o) => o.kind === 'refused') as Extract<SuspendSweepOutcome, { kind: 'refused' }>[];
  const unreachable = outcomes.filter((o) => o.kind === 'unreachable') as Extract<SuspendSweepOutcome, { kind: 'unreachable' }>[];

  const notices: string[] = [];
  if (suspendedPorts.length > 0) {
    notices.push(`Daemon serial suspended on :${suspendedPorts.join(', :')} for ${leaseSeconds}s (survives a daemon respawn).`);
  }
  if (outcomes.every((o) => o.kind === 'nothing')) {
    notices.push('No daemon is listening — nothing to suspend.');
  }

  if (refused.length > 0) {
    // It is there and said no. Refusing here beats flashing against a daemon
    // that is still holding the port.
    return {
      suspendedPorts, notices,
      refuse:
        `${refused.map((r) => r.detail).join('; ')}.\n`
        + '  Refusing to flash while a daemon that will not stand down holds the port.\n'
        + '  Stop it with `agentdeck daemon stop`, or pass --no-suspend if you have freed the port yourself.',
    };
  }
  if (unreachable.length > 0) {
    return {
      suspendedPorts, notices,
      refuse:
        `AgentDeck did not answer within 10s on ${unreachable.map((u) => `:${u.port} (${u.listener})`).join(', ')}.\n`
        + '  A daemon this silent may have a blocked event loop and can still poll the serial port open mid-write.\n'
        + '  Stop it (`agentdeck daemon stop`, or quit the AgentDeck app) and retry.',
    };
  }
  return { suspendedPorts, notices };
}


/**
 * Three answers, not two — because this is the ONLY guard against the holder
 * the lease provably cannot reach (the sandboxed Swift daemon cannot read
 * `~/.agentdeck`).
 *
 * `lsof` exits non-zero when nothing holds the file, so a failed run really is
 * the common "free" case. But it ALSO exits non-zero when it is not installed
 * (a minimal Linux container), when the 5s timeout fires, and on EPERM — and
 * collapsing those into `[]` launders "I could not look" into "nobody is
 * holding it", which is the exact trap `esp32FlashIdIsUsable` exists to avoid
 * on the flash-size axis, inverted to the permissive direction.
 */
export type PortHolderScan =
  | { known: true; holders: PortHolder[] }
  | { known: false; reason: string };

export function parseLsofHolders(stdout: string): PortHolder[] {
  const holders: PortHolder[] = [];
  let pid = 0;
  // `-F cp` still emits `f<fd>` lines; anything that is not p/c is ignored.
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('c')) holders.push({ command: line.slice(1), pid });
  }
  return holders;
}

export async function scanPortHolders(port: string): Promise<PortHolderScan> {
  if (process.platform === 'win32') {
    // No lsof at all. Stated as unknown rather than free: on Windows the open()
    // failure is the only signal, and pretending otherwise would be a claim.
    return { known: false, reason: 'lsof is not available on Windows' };
  }
  try {
    const { stdout } = await execFileAsync('lsof', ['-F', 'cp', port], { timeout: 5000 });
    return { known: true, holders: parseLsofHolders(stdout) };
  } catch (e) {
    const err = e as { code?: unknown; killed?: boolean; stdout?: string };
    // The ONE failure that means "free": lsof ran, found nothing, exited 1 with
    // no output. Everything else is a failure to observe.
    if (err.code === 1 && !err.killed && !String(err.stdout ?? '').trim()) {
      return { known: true, holders: [] };
    }
    if (err.killed) return { known: false, reason: 'lsof timed out after 5s' };
    if (err.code === 'ENOENT') return { known: false, reason: 'lsof is not installed' };
    return { known: false, reason: `lsof failed (${String(err.code ?? 'unknown error')})` };
  }
}

/** Back-compat convenience: holders, or none when they could not be observed. */
export async function whoHoldsPort(port: string): Promise<PortHolder[]> {
  const scan = await scanPortHolders(port);
  return scan.known ? scan.holders : [];
}

/**
 * Who LISTENS on a local TCP port — the companion of `scanPortHolders` for the
 * #327 suspend sweep. When a daemon's HTTP port answers nothing for the whole
 * suspend budget, the listener's identity is the difference between "an
 * AgentDeck process whose event loop is blocked and may still poll the serial
 * port open mid-write" (refuse the flash) and "some unrelated process
 * squatting a TCP port" (not a serial threat). Same failure taxonomy as
 * `scanPortHolders`: a clean "lsof found nothing" is `known: true, holders: []`,
 * everything else is stated as unknown, never laundered into empty.
 */
export async function scanTcpListener(port: number): Promise<PortHolderScan> {
  if (process.platform === 'win32') {
    return { known: false, reason: 'lsof is not available on Windows' };
  }
  try {
    const { stdout } = await execFileAsync('lsof', ['-F', 'cp', `-iTCP:${port}`, '-sTCP:LISTEN'], { timeout: 5000 });
    return { known: true, holders: parseLsofHolders(stdout) };
  } catch (e) {
    const err = e as { code?: unknown; killed?: boolean; stdout?: string };
    if (err.code === 1 && !err.killed && !String(err.stdout ?? '').trim()) {
      return { known: true, holders: [] };
    }
    if (err.killed) return { known: false, reason: 'lsof timed out after 5s' };
    if (err.code === 'ENOENT') return { known: false, reason: 'lsof is not installed' };
    return { known: false, reason: `lsof failed (${String(err.code ?? 'unknown error')})` };
  }
}

/** Processes AgentDeck itself is responsible for, and can therefore ask to let go. */
const OURS = /^(node|agentdeck|AgentDeck)$/;

export function classifyHolders(holders: PortHolder[]): { ours: PortHolder[]; foreign: PortHolder[] } {
  return {
    ours: holders.filter((h) => OURS.test(h.command)),
    foreign: holders.filter((h) => !OURS.test(h.command)),
  };
}

/* -------------------------------------------------------------- the write */

export interface FlashProgress {
  onPhase?: (phase: string) => void;
  onProgress?: (written: number, total: number) => void;
  log?: (msg: string) => void;
}

export interface FlashOutcome {
  chip: string;
  mac: string;
  flashSize?: string;
  verdict: Esp32PreflightVerdict;
  bytes: number;
  elapsedMs: number;
}

/**
 * Bound a teardown await that can never be trusted to return.
 *
 * `Transport.disconnect()` calls `waitForUnlock()`, a `while (locked)` spin
 * with NO deadline — and `Transport.write()` has no try/finally, so a rejected
 * `writer.write()` (board unplugged, native-USB CDC re-enumerating, driver
 * error mid-write) leaves the writable stream locked permanently. The spin then
 * never exits.
 *
 * That matters far more than a leaked handle: this runs in the `finally` that
 * the CLI's own `finally` waits on before POSTing `/esp32/serial/resume`. A
 * hang there means the command produces no further output AND the daemon's
 * serial layer stays down for the entire 420s/900s lease. Abandoning the
 * teardown is strictly better than inheriting its hang — the fd is released
 * when the process exits, and the lease expires on its own clock.
 *
 * Repo rule: every await on an external peer gets a bound.
 */
async function bounded(work: Promise<unknown>, ms: number, what: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work.catch(() => undefined),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }),
    ]);
  } catch {
    // A teardown failure is never worth surfacing over the outcome it follows.
  } finally {
    if (timer) clearTimeout(timer);
  }
  void what;
}

/**
 * Connect, identify, refuse-or-write, verify by MD5. Mirrors the browser's
 * `flash.ts` step for step; the two share `esp32PreflightVerdict` so they can
 * never disagree about which board may be written.
 */
export async function flashBoard(
  board: Esp32BoardSpec,
  portPath: string,
  image: Buffer,
  geometry: Pick<ManifestBoardEntry, 'flashMode' | 'flashFreq' | 'flashSize'> &
    Partial<Pick<ManifestBoardEntry, 'chipFamily'>>,
  opts: { eraseAll?: boolean; baud?: number; imageIsFromManifest?: boolean } = {},
  cb: FlashProgress = {},
): Promise<FlashOutcome> {
  const SerialPort = await loadSerialPort();
  if (!SerialPort) {
    throw new Error(
      'serialport is not installed (it is an optional native dependency).\n' +
        '  Install it with:  npm install -g serialport\n' +
        '  or reinstall AgentDeck so the optional dependency builds:  npx @agentdeck/setup\n' +
        '  Alternatively flash from a browser at https://puritysb.github.io/AgentDeck/flash/',
    );
  }

  const info = (await listCandidatePorts()).find((p) => p.path === portPath);
  const device = new NodeWebSerialPort(portPath, {
    usbVendorId: info?.usbVendorId,
    usbProductId: info?.usbProductId,
  });

  const t0 = Date.now();
  const transport = new Transport(device as unknown as SerialPort, false);
  const loader = new ESPLoader({
    transport,
    baudrate: opts.baud ?? board.uploadBaud,
    terminal: {
      clean() {},
      writeLine: (d: string) => cb.log?.(d),
      write: (d: string) => cb.log?.(d),
    },
    debugLogging: false,
  });

  try {
    cb.onPhase?.('connect');
    let chip: string;
    if (board.stub) {
      chip = await loader.main(board.before);
    } else {
      // The no-stub equivalent of main(): everything except runStub(). Some
      // envs pin --no-stub and some REQUIRE the stub (t_display_pro's
      // "stub + 230400" is a verified combination; t_embed broke when the
      // CH340 envs' no-stub flags were copied onto it) — that axis is in the
      // SSOT, not decided here.
      await loader.detectChip(board.before);
      chip = await loader.chip.getChipDescription(loader);
      if (loader.chip.postConnect) await loader.chip.postConnect(loader);
      if ((opts.baud ?? board.uploadBaud) !== 115200) await loader.changeBaud();
    }

    cb.onPhase?.('identify');
    const mac = await loader.chip.readMac(loader);
    const flashId = (await loader.readFlashId()).toString(16);
    // detectFlashSize() answers "4MB" when it cannot decode the id, so an
    // unusable id must stay unknown rather than becoming a confident wrong
    // number that then gates the write.
    const flashSize = esp32FlashIdIsUsable(flashId) ? await loader.detectFlashSize() : undefined;

    const verdict = esp32PreflightVerdict({
      board,
      surface: 'cli',
      detectedChip: chip,
      detectedFlashSize: flashSize,
      // Only when the geometry came from a manifest. A hand-supplied
      // --firmware has none to disagree with, and inventing one from the board
      // spec would make the check compare a value against itself.
      imageGeometry: opts.imageIsFromManifest
        ? { chipFamily: String(geometry.chipFamily), flashSize: geometry.flashSize }
        : undefined,
    });
    if (!verdict.mayWrite) {
      throw new Error(
        `refusing to write ${board.id}: ${verdict.code}\n` +
          `  detected: ${chip}${flashSize ? `, flash ${flashSize}` : ''}\n` +
          `  expected: ${board.chipFamily}, flash ${board.flashSize}\n` +
          (verdict.code === 'image-geometry-mismatch'
            ? `  the image says: ${geometry.chipFamily ?? '?'}, flash ${geometry.flashSize}\n` +
              '  The release you are installing was built for different geometry than this\n' +
              '  build knows this board to have. Use a matching --tag.\n'
            : '') +
          '  There is no --force. Pick the board you actually have.',
      );
    }

    if (opts.eraseAll && !board.stub) {
      // esptool-js only honours eraseAll on the stub path (esploader.js:
      // `if (this.IS_STUB === true && options.eraseAll === true)`). Silently
      // skipping it would hand back a board still carrying the previous owner's
      // Wi-Fi credentials and pairing token, right after printing "erase" and
      // "MD5 verified".
      throw new Error(
        `--erase cannot be honoured on ${board.id}: it flashes through the ROM loader\n` +
          '  (--no-stub), where esptool-js has no erase command. Re-run without --erase to\n' +
          '  write the firmware, or erase the chip with esptool.py.',
      );
    }
    cb.onPhase?.(opts.eraseAll ? 'erase' : 'write');
    await loader.writeFlash({
      fileArray: [{ data: new Uint8Array(image), address: 0x0 }],
      flashMode: geometry.flashMode as 'dio',
      flashFreq: geometry.flashFreq as '80m',
      flashSize: geometry.flashSize as '16MB',
      // Only honoured on the stub path; a no-op rather than an error on a
      // --no-stub board.
      eraseAll: opts.eraseAll ?? false,
      // COMPRESSED WRITES NEED THE STUB. The ROM loader has no compressed
      // flash mode, so a --no-stub board fails at the first block with
      // "Failed to enter compressed flash mode failed with status 1,5" —
      // before a single byte is written. ttgo_t_display is `webFlash: true`
      // and stubless, so it was offered on /flash/ and could not be written by
      // either surface; its evidence only ever recorded that it CONNECTS.
      compress: board.stub,
      reportProgress: (_i, written, total) => cb.onProgress?.(written, total),
      // Hashed AFTER esptool-js patches the flash-params header, which is why
      // this is a callback and not a hash of `image`. A mismatch throws.
      calculateMD5Hash: (patched: Uint8Array) => createHash('md5').update(patched).digest('hex'),
    });

    cb.onPhase?.('verify');
    try {
      // Pass the SSOT value straight through. esptool-js's after() handles all
      // four of Esp32ResetAfter natively (esploader.js:1523), so collapsing
      // everything but 'no_reset' into a hard reset would silently override a
      // board that deliberately asks for 'soft_reset' or 'no_reset_stub' — a
      // wrong reset on a board whose flags are an accident record.
      // NOT `after(board.after)`. esptool-js's hard reset is a release with no
      // assert, so once a write has finished it is a no-op: the chip stays
      // parked in the flasher stub, the firmware never runs, and the
      // device_info read-back below cannot succeed however long it waits. The
      // SSOT sequence is measured to boot both adapter classes. A board that
      // asks not to be reset resolves to undefined and keeps its own `after`.
      const resetSeq = esp32PostWriteResetSequence(board);
      if (resetSeq) await loader.after('custom_reset', undefined, resetSeq);
      else await loader.after(board.after);
    } catch (e) {
      // Say it. The write already landed and was verified, so this never fails
      // the command — but the reset is exactly what the boot check below
      // depends on, and swallowing it silently makes a board left parked in the
      // stub byte-identical to a board that booted and stayed quiet.
      cb.log?.(`reset after write failed (${e instanceof Error ? e.message : String(e)}) — the board may need a power cycle`);
    }

    return { chip, mac, flashSize, verdict, bytes: image.length, elapsedMs: Date.now() - t0 };
  } finally {
    // Bounded, in this order: disconnect tries to leave the port unlocked, and
    // close releases the fd whether or not it managed to.
    await bounded(transport.disconnect(), 4000, 'transport.disconnect');
    await bounded(device.close(), 4000, 'device.close');
  }
}

/* --------------------------------------------------------- post-write check
 * MD5 proves the bytes landed. It does NOT prove the board boots them — a
 * correct image with a wrong flash-size header verifies perfectly and then
 * bootloops. So the board is asked to introduce itself.
 */

export interface DeviceIdentity {
  board?: string;
  version?: string;
  buildHash?: string;
}

/**
 * Reopen the port at 115200 and wait for the firmware's `device_info`.
 *
 * `ulanzi_tc001` MUST SKIP THIS. Its CH340 TX is broken in hardware, so it
 * never answers any serial probe — running this on a TC001 reports a perfectly
 * good flash as a failure. The exception is named in the SSOT's notes, in
 * docs/esp32.md, and in the browser flasher's done-state copy.
 */
export const SERIAL_PROBE_UNAVAILABLE = new Set(['ulanzi_tc001']);

export async function readDeviceIdentity(
  portPath: string,
  timeoutMs = 20_000,
): Promise<DeviceIdentity | null> {
  const SerialPort = await loadSerialPort();
  if (!SerialPort) return null;

  return new Promise<DeviceIdentity | null>((resolve) => {
    // Every handle `done` touches is declared before anything can call it.
    // `done` is reachable from the `error` listener, and a synchronous failure
    // would otherwise run it while `const timer` / `const asker` were still in
    // their temporal dead zone — a ReferenceError instead of the `null` this
    // function promises. Which matters because it runs AFTER a successful
    // write: a throw here reports a good flash as a failure.
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    let asker: ReturnType<typeof setInterval> | undefined = undefined;
    let port: InstanceType<typeof SerialPort> | undefined;

    const done = (v: DeviceIdentity | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (asker) clearInterval(asker);
      try { port?.close(() => {}); } catch { /* already closed, or never opened */ }
      resolve(v);
    };
    // Bounded, always: a board that boots into a crash loop writes nothing and
    // an unbounded wait here would hang the command after a SUCCESSFUL write.
    timer = setTimeout(() => done(null), timeoutMs);

    try {
      port = new SerialPort({ path: portPath, baudRate: 115200, autoOpen: false });
    } catch {
      // A vanished device node (a native-USB board re-enumerating after its
      // reset) throws from the constructor. That is "did not report in", not a
      // failed flash.
      return done(null);
    }
    let buf = '';
    port.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      // Firmware speaks newline-delimited JSON with plain debug lines mixed in.
      for (const line of buf.split('\n').slice(0, -1)) {
        if (!line.trim().startsWith('{')) continue;
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          if (msg.type === 'device_info') {
            done({
              board: typeof msg.board === 'string' ? msg.board : undefined,
              version: typeof msg.version === 'string' ? msg.version : undefined,
              buildHash: typeof msg.buildHash === 'string' ? msg.buildHash : undefined,
            });
            return;
          }
        } catch { /* a partial or non-JSON line — keep reading */ }
      }
      // Keep only the trailing partial line, so a complete line is parsed once.
      buf = buf.slice(buf.lastIndexOf('\n') + 1);
      // A board stuck printing a panic dump without newlines would otherwise
      // grow this string for the whole timeout. Nothing this long is a protocol
      // line, so drop it rather than accumulate it.
      if (buf.length > 64 * 1024) buf = '';
    });
    port.on('error', () => done(null));
    port.open((err: Error | null) => {
      if (err) return done(null);
      port?.write('{"type":"device_info_request"}\n');
    });
    // The board may still be booting when the first ask goes out.
    asker = setInterval(() => {
      if (port?.isOpen) port.write('{"type":"device_info_request"}\n');
    }, 3000);
  });
}
