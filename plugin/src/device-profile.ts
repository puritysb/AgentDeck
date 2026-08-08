/** Canonical Stream Deck device families from Elgato's DeviceType enum. */
export function familyForDeviceType(type: number | undefined): string {
  switch (type) {
    case 0: return 'streamdeck';
    case 1: return 'streamdeckmini';
    case 2: return 'streamdeckxl';
    case 3: return 'streamdeckmobile';
    case 4: return 'corsairgkeys';
    case 5: return 'streamdeckpedal';
    case 6: return 'corsairvoyager';
    case 7: return 'streamdeckplus';
    case 8: return 'scufcontroller';
    case 9: return 'streamdeckneo';
    case 10: return 'streamdeckstudio';
    case 11: return 'streamdeckvirtual';
    case 12: return 'galleon100sd';
    case 13: return 'streamdeckplusxl';
    default: return 'streamdeck-unknown';
  }
}

/** The original 5x3 deck downsamples key art to 72px square. */
export function usesLowResolutionKeyProfile(
  family: string | undefined,
  columns: number,
  rows: number,
): boolean {
  return family === 'streamdeck'
    || (family === 'streamdeck-unknown' && columns === 5 && rows === 3);
}
