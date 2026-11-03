/**
 * Pairing-token convergence between the two daemons that can serve one machine.
 *
 * The Node CLI daemon and the macOS app's in-process Swift daemon keep their
 * token in different files, and the sandboxed app cannot read
 * `~/.agentdeck/auth-token`. Before this, whichever daemon happened to own the
 * port decided whether every paired ESP32 board authenticated — a handover in
 * either direction closed the whole fleet 4001. `adoptPeerToken` is the fix:
 * whoever starts second adopts what the incumbent already serves.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TOKEN_A = 'a'.repeat(32);
const TOKEN_B = 'b'.repeat(32);
const TOKEN_C = 'c'.repeat(32);

let dir: string;
let auth: typeof import('../auth.js');

/** Fresh module instance — the token cache is keyed by data dir, but a fresh
 *  import also pins `LEGACY_DIR`, which is resolved once at load. */
async function loadAuth(): Promise<typeof import('../auth.js')> {
  vi.resetModules();
  return await import('../auth.js');
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentdeck-auth-'));
  process.env.AGENTDECK_DATA_DIR = dir;
  auth = await loadAuth();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENTDECK_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('adoptPeerToken', () => {
  it('rejects non-string token inputs before touching string operations or token storage', () => {
    for (const candidate of [null, undefined, 42, {}, [], new Array(32).fill('a'),
      { length: 32, charCodeAt: () => 97 }, Buffer.from(TOKEN_A)]) {
      expect(auth.validateToken(candidate)).toBe(false);
    }
    expect(existsSync(join(dir, 'auth-token'))).toBe(false);
    writeFileSync(join(dir, 'auth-token'), TOKEN_A + '\n');
    expect(auth.validateToken(TOKEN_A)).toBe(true);
  });

  it('serves the incumbent daemon token after adopting it', () => {
    writeFileSync(join(dir, 'auth-token'), TOKEN_A + '\n');
    expect(auth.getOrCreateToken()).toBe(TOKEN_A);

    expect(auth.adoptPeerToken(TOKEN_B)).toBe(true);

    expect(auth.getOrCreateToken()).toBe(TOKEN_B);
    expect(readFileSync(join(dir, 'auth-token'), 'utf-8').trim()).toBe(TOKEN_B);
  });

  it('keeps accepting the superseded token so devices are not locked out mid-convergence', () => {
    writeFileSync(join(dir, 'auth-token'), TOKEN_A + '\n');
    auth.adoptPeerToken(TOKEN_B);

    // A board provisioned a moment before the handover still holds TOKEN_A.
    expect(auth.validateToken(TOKEN_A)).toBe(true);
    expect(auth.validateToken(TOKEN_B)).toBe(true);
    expect(auth.validateToken(TOKEN_C)).toBe(false);
  });

  it('survives a restart — adoption is persisted, not in-memory', async () => {
    writeFileSync(join(dir, 'auth-token'), TOKEN_A + '\n');
    auth.adoptPeerToken(TOKEN_B);

    const reloaded = await loadAuth();
    expect(reloaded.getOrCreateToken()).toBe(TOKEN_B);
    expect(reloaded.validateToken(TOKEN_A)).toBe(true);
  });

  it('is a no-op when the incumbent serves the token we already hold', () => {
    writeFileSync(join(dir, 'auth-token'), TOKEN_A + '\n');
    expect(auth.adoptPeerToken(TOKEN_A)).toBe(false);
    expect(auth.getAcceptedTokens()).toEqual([]);
  });

  it('refuses a missing or malformed peer token rather than adopting a blank credential', () => {
    writeFileSync(join(dir, 'auth-token'), TOKEN_A + '\n');
    for (const bad of [undefined, null, '', '   ', 'short', 42, {}]) {
      expect(auth.adoptPeerToken(bad)).toBe(false);
    }
    expect(auth.getOrCreateToken()).toBe(TOKEN_A);
  });

  it('bounds the accepted key ring instead of growing it forever', () => {
    writeFileSync(join(dir, 'auth-token'), TOKEN_A + '\n');
    for (let i = 0; i < 8; i++) auth.adoptPeerToken(String(i).repeat(32));
    expect(auth.getAcceptedTokens().length).toBeLessThanOrEqual(4);
  });

  it('never records the same token twice in the ring', () => {
    writeFileSync(join(dir, 'auth-token'), TOKEN_A + '\n');
    auth.adoptPeerToken(TOKEN_B);
    auth.adoptPeerToken(TOKEN_A);
    auth.adoptPeerToken(TOKEN_B);
    const ring = auth.getAcceptedTokens();
    expect(new Set(ring).size).toBe(ring.length);
  });
});

describe('rotateToken', () => {
  it('retires the accepted ring too, or rotation would not retire a leaked token', () => {
    writeFileSync(join(dir, 'auth-token'), TOKEN_A + '\n');
    auth.adoptPeerToken(TOKEN_B);
    expect(auth.validateToken(TOKEN_A)).toBe(true);

    const rotated = auth.rotateToken();

    expect(auth.validateToken(TOKEN_A)).toBe(false);
    expect(auth.validateToken(TOKEN_B)).toBe(false);
    expect(auth.validateToken(rotated)).toBe(true);
    expect(auth.getAcceptedTokens()).toEqual([]);
  });
});

describe('data-dir resolution', () => {
  it('keeps the token beside the rest of the daemon state', () => {
    const token = auth.getOrCreateToken();
    expect(existsSync(join(dir, 'auth-token'))).toBe(true);
    expect(readFileSync(join(dir, 'auth-token'), 'utf-8').trim()).toBe(token);
  });

  it('inherits the legacy credential instead of un-pairing an existing fleet', async () => {
    // A machine that already had a token and then gained a custom data dir:
    // minting a fresh one here would silently invalidate every provisioned
    // device, which is the exact failure this whole change is about.
    const fakeHome = mkdtempSync(join(tmpdir(), 'agentdeck-home-'));
    mkdirSync(join(fakeHome, '.agentdeck'), { recursive: true });
    writeFileSync(join(fakeHome, '.agentdeck', 'auth-token'), TOKEN_A + '\n');
    const realHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const mod = await loadAuth();
      expect(mod.getOrCreateToken()).toBe(TOKEN_A);
      // …and carries it into the new dir, so later reads are self-contained.
      expect(readFileSync(join(dir, 'auth-token'), 'utf-8').trim()).toBe(TOKEN_A);
    } finally {
      if (realHome === undefined) delete process.env.HOME;
      else process.env.HOME = realHome;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});

describe('persisted pairing retirement', () => {
  it('does not resurrect a leaked token after adopting a rotated peer and restarting', async () => {
    writeFileSync(join(dir, 'auth-token'), TOKEN_A + '\n');
    auth.adoptPeerToken(TOKEN_B);
    const metadata = { version: 1, revision: 1, eventId: '1'.repeat(32) };
    expect(auth.adoptPeerToken(TOKEN_C, metadata)).toBe(true);
    expect(auth.validateToken(TOKEN_A)).toBe(false);
    expect(auth.validateToken(TOKEN_B)).toBe(false);
    // Even a stale legacy writer must not outrank the atomic retirement.
    writeFileSync(join(dir, 'auth-token'), TOKEN_A + '\n');
    writeFileSync(join(dir, 'auth-token-accepted'), TOKEN_A + '\n' + TOKEN_B + '\n');
    const reloaded = await loadAuth();
    expect(reloaded.getOrCreateToken()).toBe(TOKEN_C);
    expect(reloaded.getAcceptedTokens()).toEqual([]);
    expect(() => reloaded.adoptPeerToken(TOKEN_A)).toThrow('retired-peer-state');
    expect(reloaded.validateToken(TOKEN_A)).toBe(false);
    expect(reloaded.validateToken(TOKEN_C)).toBe(true);
  });

  it('refuses conflicting and stale peer retirement state without changing the token', () => {
    const token = auth.rotateToken();
    const metadata = auth.getPairingRetirement();
    expect(() => auth.adoptPeerToken(TOKEN_A, { ...metadata, eventId: '2'.repeat(32) })).toThrow('conflicting-retirement');
    expect(() => auth.adoptPeerToken(TOKEN_A, { ...metadata, revision: 0, eventId: '' })).toThrow('retired-peer-state');
    expect(auth.getOrCreateToken()).toBe(token);
  });

  it('never falls back to old files when authoritative state is corrupt', async () => {
    auth.rotateToken();
    writeFileSync(join(dir, 'auth-credentials.json'), '{broken');
    const reloaded = await loadAuth();
    expect(() => reloaded.getOrCreateToken()).toThrow('Pairing credential state is invalid; refusing legacy fallback');
    expect(() => reloaded.validateToken(TOKEN_A)).toThrow();
  });

  it('keeps an acknowledged retirement in a private atomic state file', async () => {
    const token = auth.rotateToken();
    const state = JSON.parse(readFileSync(join(dir, 'auth-credentials.json'), 'utf8'));
    expect(state).toMatchObject({ token, accepted: [], revision: 1 });
    const reloaded = await loadAuth();
    expect(reloaded.getPairingRetirement()).toEqual(auth.getPairingRetirement());
    expect(reloaded.getOrCreateToken()).toBe(token);
  });
});


describe('legacy convergence without optional native storage', () => {
  it('preserves ordinary legacy adoption while rotation never falls back', async () => {
    writeFileSync(join(dir,'auth-token'),TOKEN_A + '\n');
    const store = await import('../pairing-credential-store.js');
    vi.spyOn(store,'mutateCredentialState').mockImplementation(() => {throw new Error('native SQLite unavailable');});
    expect(auth.adoptPeerToken(TOKEN_B)).toBe(true);
    expect(auth.validateToken(TOKEN_A)).toBe(true);
    expect(existsSync(join(dir,'auth-credentials.json'))).toBe(false);
    expect(() => auth.rotateToken()).toThrow('unavailable');
    expect(auth.getOrCreateToken()).toBe(TOKEN_B);
  });
  it('never falls back to mirrors after an authoritative fence exists', async () => {
    auth.rotateToken();
    const store = await import('../pairing-credential-store.js');
    vi.spyOn(store,'mutateCredentialState').mockImplementation(() => {throw new Error('storage busy');});
    const metadata = {...auth.getPairingRetirement(),revision:2,eventId:'f'.repeat(32)};
    expect(() => auth.adoptPeerToken(TOKEN_A,metadata)).toThrow('storage busy');
    expect(auth.validateToken(TOKEN_A)).toBe(false);
  });
});


it('refuses an explicitly unavailable corrected peer rather than treating it as tokenless legacy health', () => {
  expect(auth.adoptPeerToken(undefined)).toBe(false);
  expect(() => auth.adoptPeerToken(null,null)).toThrow('unavailable');
  expect(() => auth.adoptPeerToken(null,{version:1,revision:0,eventId:''})).toThrow('unavailable');
});


it('closes a previously opened pairing code when retirement is committed', async () => {
  const window = await import('../pairing-window.js');
  window.openPairingWindow();
  expect(window.pairingWindowOpen()).toBe(true);
  auth.rotateToken();
  expect(window.pairingWindowOpen()).toBe(false);
});
