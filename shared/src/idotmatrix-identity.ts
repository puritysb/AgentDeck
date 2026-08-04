/**
 * iDotMatrix BLE identity SSOT — the GATT UUIDs and the advertised-name
 * families that identify a panel speaking the iDotMatrix protocol.
 *
 * The same 32x32 panel ships under several brand names (iDotMatrix `IDM-…`,
 * iPixel `iPixel-…`), so discovery must not key on one vendor's name prefix.
 * Issue #115 was exactly that: an iPixel panel that connects and renders fine
 * once its address is hand-written into `settings.json` never appeared in any
 * Scan UI, because both scanners filtered on `IDM-`. Match the advertised
 * service UUID first (protocol truth, brand-independent) and fall back to the
 * known name families for panels that keep the service out of their
 * advertisement packet — the fallback is why the scan filter cannot be
 * service-only either.
 *
 * Two scanners consume this: the Swift CoreBluetooth one in the App Store
 * daemon and the Python/bleak one in the terminal-managed daemon. Neither can
 * import TypeScript, so both read generated mirrors of this file:
 *   pnpm generate-idotmatrix-identity
 * drift-gated by `shared/src/__tests__/idotmatrix-identity.test.ts`.
 */

/** Advertised service that carries the DIY-drawing write characteristic. */
export const IDOTMATRIX_SERVICE_UUID = '000000fa-0000-1000-8000-00805f9b34fb';

/** Write-without-response characteristic used for mode/brightness/image. */
export const IDOTMATRIX_WRITE_CHARACTERISTIC_UUID = '0000fa02-0000-1000-8000-00805f9b34fb';

/**
 * Known advertised-name families, uppercase; compared case-insensitively as
 * prefixes. A user can widen this at runtime with `idotmatrixNamePrefixes` in
 * settings.json rather than waiting on a release for the next rebrand.
 */
export const IDOTMATRIX_NAME_PREFIXES: readonly string[] = ['IDM-', 'IPIXEL'];

/**
 * Expand a 16-bit (`fa02`) or 32-bit (`000000fa`) BLE UUID to its full
 * Bluetooth-base 128-bit form, lowercased. Advertisement payloads carry
 * whichever form the peripheral chose to transmit, and CoreBluetooth hands
 * back the short one verbatim, so equality has to run on the expanded string.
 * Short forms are left-padded first — `CBUUID.uuidString` is not guaranteed to
 * keep leading zeroes, and `fa` and `00fa` are the same service.
 */
export function normalizeBleUuid(value: string): string {
  const s = value.trim().toLowerCase();
  if (/^[0-9a-f]{1,4}$/.test(s)) return `0000${s.padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;
  if (/^[0-9a-f]{5,8}$/.test(s)) return `${s.padStart(8, '0')}-0000-1000-8000-00805f9b34fb`;
  return s;
}

/** Whether an advertised local name belongs to a known iDotMatrix family. */
export function matchesIDotMatrixName(
  name: string,
  extraPrefixes: readonly string[] = [],
): boolean {
  const n = name.trim().toUpperCase();
  if (!n) return false;
  for (const prefix of [...IDOTMATRIX_NAME_PREFIXES, ...extraPrefixes]) {
    const p = prefix.trim().toUpperCase();
    if (p && n.startsWith(p)) return true;
  }
  return false;
}

/**
 * The discovery predicate both scanners apply to every peripheral they see:
 * service UUID first, known/configured name families second.
 */
export function isIDotMatrixAdvertisement(
  advertisement: { name?: string; serviceUuids?: readonly string[] },
  extraPrefixes: readonly string[] = [],
): boolean {
  for (const uuid of advertisement.serviceUuids ?? []) {
    if (normalizeBleUuid(uuid) === IDOTMATRIX_SERVICE_UUID) return true;
  }
  return matchesIDotMatrixName(advertisement.name ?? '', extraPrefixes);
}
