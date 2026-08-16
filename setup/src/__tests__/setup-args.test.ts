import { beforeAll, describe, expect, it } from 'vitest';

// setup.ts runs its installer on import; the env guard keeps this test from
// npm-installing the bridge onto the machine running CI.
process.env.AGENTDECK_SETUP_NO_AUTORUN = '1';

let parseSetupArgs: typeof import('../setup.js').parseSetupArgs;

beforeAll(async () => {
  ({ parseSetupArgs } = await import('../setup.js'));
});

describe('parseSetupArgs', () => {
  it('prints next steps by default instead of installing the daemon', () => {
    expect(parseSetupArgs([])).toEqual({ enterprise: false, autoInstallDaemon: false });
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
    });
  });

  it('ignores unknown flags rather than refusing to install', () => {
    expect(parseSetupArgs(['--entrprise', '--yes'])).toEqual({
      enterprise: false,
      autoInstallDaemon: true,
    });
  });
});
