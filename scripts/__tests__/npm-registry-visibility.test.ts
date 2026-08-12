import { describe, expect, it, vi } from 'vitest';

import { waitForRegistryVersion } from '../npm-registry-visibility.mjs';

describe('npm registry visibility', () => {
  it('retries until a newly published version becomes visible', async () => {
    const check = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValue(true);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();

    await expect(
      waitForRegistryVersion(check, '@agentdeck/setup', '1.0.18', {
        attempts: 4,
        intervalMs: 25,
        sleep,
        log,
      }),
    ).resolves.toBe(true);

    expect(check).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 25);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('fails after the bounded attempt count', async () => {
    const check = vi.fn().mockReturnValue(false);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      waitForRegistryVersion(check, '@agentdeck/setup', '1.0.18', {
        attempts: 3,
        intervalMs: 10,
        sleep,
        log: vi.fn(),
      }),
    ).resolves.toBe(false);

    expect(check).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
