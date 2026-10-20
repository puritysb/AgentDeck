import { beforeAll, describe, expect, it } from 'vitest';

// setup.ts runs its installer on import; the env guard keeps this test from
// npm-installing the bridge onto the machine running CI.
process.env.AGENTDECK_SETUP_NO_AUTORUN = '1';

let parseSetupArgs: typeof import('../setup.js').parseSetupArgs;
let isSupportedNodeMajor: typeof import('../setup.js').isSupportedNodeMajor;

beforeAll(async () => {
  ({ parseSetupArgs, isSupportedNodeMajor } = await import('../setup.js'));
});

describe('Node runtime support contract', () => {
  it('accepts the maintained even release lines', () => {
    expect([22, 24, 26].map(isSupportedNodeMajor)).toEqual([true, true, true]);
  });

  it('rejects EOL Node 20 and short-lived odd release lines', () => {
    expect([20, 21, 23, 25, 27].map(isSupportedNodeMajor)).toEqual([false, false, false, false, false]);
  });
});

describe('parseSetupArgs', () => {
  it('prints next steps by default instead of installing the daemon', () => {
    expect(parseSetupArgs([])).toEqual({ enterprise: false, autoInstallDaemon: false, statusline: false, surface: null });
  });

  it('--yes / -y finishes the install without a second command', () => {
    expect(parseSetupArgs(['--yes']).autoInstallDaemon).toBe(true);
    expect(parseSetupArgs(['-y']).autoInstallDaemon).toBe(true);
  });

  it('--enterprise implies --yes', () => {
    // A posture printed as a suggested next step is not a posture: if the
    // admin has to run a second command, the locked-down daemon is the one
    // thing that does not get installed.
    expect(parseSetupArgs(['--enterprise'])).toEqual({
      enterprise: true,
      autoInstallDaemon: true,
      statusline: false,
      surface: null,
    });
  });

  it('ignores unknown flags rather than refusing to install', () => {
    expect(parseSetupArgs(['--entrprise', '--yes'])).toEqual({
      enterprise: false,
      autoInstallDaemon: true,
      statusline: false,
      surface: null,
    });
  });

  it('--statusline opts into the Claude status-line relay without implying --yes', () => {
    expect(parseSetupArgs(['--statusline'])).toEqual({
      enterprise: false,
      autoInstallDaemon: false,
      statusline: true,
      surface: null,
    });
  });

  it('--surface forces the deck host the next steps describe, in either spelling', () => {
    expect(parseSetupArgs(['--yes', '--surface=ulanzi']).surface).toBe('ulanzi');
    expect(parseSetupArgs(['--surface', 'streamdeck']).surface).toBe('streamdeck');
    expect(parseSetupArgs(['--surface=D200H']).surface).toBe('ulanzi');
    // --surface does not imply --yes: it only chooses what is printed.
    expect(parseSetupArgs(['--surface=ulanzi']).autoInstallDaemon).toBe(false);
  });

  it('an unknown --surface value is ignored, like an unknown flag', () => {
    expect(parseSetupArgs(['--surface=lcd']).surface).toBeNull();
    expect(parseSetupArgs(['--surface']).surface).toBeNull();
  });
});
