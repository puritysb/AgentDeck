import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildHookEntry } from '@agentdeck/hooks';
import { buildSetupStatusPayload, claudeHookPresence, withinBudget } from '../setup-status.js';

/**
 * `/setup-status` is readable cross-origin, so its shape is a security contract
 * as much as a wire one. Both daemons replay shared/setup-status-contract.json
 * (Swift: apple/AgentDeckTests/SetupStatusContractTests.swift).
 */
const ROOT = join(__dirname, '..', '..', '..');
const contract = JSON.parse(readFileSync(join(ROOT, 'shared', 'setup-status-contract.json'), 'utf8')) as {
  keys: string[]; claudeHooksValues: string[]; forbiddenKeyPattern: string; forbiddenKeys: string[];
};

describe('GET /setup-status payload (Node)', () => {
  const payload = buildSetupStatusPayload({ port: 9120, state: 'disconnected', sessions: 3, claudeHooks: 'installed' });

  it('answers exactly the contract keys — nothing a web page should not read', () => {
    expect(Object.keys(payload).sort()).toEqual([...contract.keys].sort());
    for (const key of Object.keys(payload)) expect(key).not.toMatch(new RegExp(contract.forbiddenKeyPattern, 'i'));
    for (const key of contract.forbiddenKeys) expect(payload).not.toHaveProperty(key);
  });

  it('carries the session COUNT even while the state word says disconnected', () => {
    // The daemon's state is "disconnected" whenever no managed session is
    // focused, which is the normal case for observed sessions — the reason the
    // Property Inspector said "No agent session yet" over a full deck.
    expect(payload).toMatchObject({ state: 'disconnected', sessions: 3, isSwift: false });
    expect(Number.isInteger(payload.sessions)).toBe(true);
  });

  it('says "could not look" as null, not as zero', () => {
    const unknown = buildSetupStatusPayload({ port: 9120, state: 'idle', sessions: null, claudeHooks: 'unknown' });
    expect(unknown.sessions).toBeNull();
    expect(JSON.parse(JSON.stringify(unknown))).toHaveProperty('sessions', null);
    expect(contract.claudeHooksValues).toContain(unknown.claudeHooks);
  });

  it('is what daemon-server.ts serves on the route, with the CORS header', () => {
    const src = readFileSync(join(ROOT, 'bridge', 'src', 'daemon-server.ts'), 'utf8');
    const route = src.slice(src.indexOf("pathname === '/setup-status'"));
    const block = route.slice(0, route.indexOf('return;\n    }'));
    expect(block).toContain('buildSetupStatusPayload(');
    expect(block).toContain("'Access-Control-Allow-Origin': '*'");
    expect(block).not.toMatch(/pairingToken|authToken|getToken/);
  });
});

describe('claudeHookPresence', () => {
  let home: string | undefined;
  afterEach(() => { if (home) rmSync(home, { recursive: true, force: true }); home = undefined; });
  const withSettings = (content: string | null) => {
    home = mkdtempSync(join(tmpdir(), 'agentdeck-setup-status-'));
    if (content !== null) {
      mkdirSync(join(home, '.claude'), { recursive: true });
      writeFileSync(join(home, '.claude', 'settings.json'), content);
    }
    return home;
  };

  it('installed when the user settings carry an AgentDeck hook', () => {
    const settings = { hooks: { Stop: [buildHookEntry('Stop', '/home/someone')] } };
    expect(claudeHookPresence(withSettings(JSON.stringify(settings)))).toBe('installed');
  });

  it('missing when there is no settings file, or no AgentDeck hook in it', () => {
    expect(claudeHookPresence(withSettings(null))).toBe('missing');
    const foreign = { hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'echo done' }] }] } };
    expect(claudeHookPresence(withSettings(JSON.stringify(foreign)))).toBe('missing');
  });

  it('unknown — never missing — when the file cannot be parsed', () => {
    expect(claudeHookPresence(withSettings('{ not json'))).toBe('unknown');
  });
});

describe('withinBudget', () => {
  it('returns the value when the work finishes in time, null when it does not', async () => {
    expect(await withinBudget(Promise.resolve(4), 50)).toBe(4);
    expect(await withinBudget(new Promise(() => {}), 10)).toBeNull();
    expect(await withinBudget(Promise.reject(new Error('scan failed')), 50)).toBeNull();
  });
});
