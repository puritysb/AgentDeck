import { describe, expect, it } from 'vitest';
import { familyForDeviceType, usesLowResolutionKeyProfile } from '../device-profile.js';

describe('Stream Deck device profiles', () => {
  it('maps every documented Elgato DeviceType without conflating families', () => {
    expect(Array.from({ length: 14 }, (_, type) => familyForDeviceType(type))).toEqual([
      'streamdeck', 'streamdeckmini', 'streamdeckxl', 'streamdeckmobile',
      'corsairgkeys', 'streamdeckpedal', 'corsairvoyager', 'streamdeckplus',
      'scufcontroller', 'streamdeckneo', 'streamdeckstudio', 'streamdeckvirtual',
      'galleon100sd', 'streamdeckplusxl',
    ]);
    expect(familyForDeviceType(99)).toBe('streamdeck-unknown');
  });

  it('uses the larger text profile only for original 72px keys', () => {
    expect(usesLowResolutionKeyProfile('streamdeck', 5, 3)).toBe(true);
    expect(usesLowResolutionKeyProfile('streamdeck-unknown', 5, 3)).toBe(true);
    expect(usesLowResolutionKeyProfile('streamdeckxl', 8, 4)).toBe(false);
    expect(usesLowResolutionKeyProfile('streamdeckplus', 4, 2)).toBe(false);
  });
});
