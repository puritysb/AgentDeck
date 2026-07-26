import { execFileSync } from './proc.js';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface AntigravityStatusInfo {
  planName?: string;
  availableCredits?: number;
  minimumCreditAmountForUsage?: number;
  subscriptionActiveUntil?: string;
}

const DB_PATH = join(
  homedir(),
  'Library/Application Support/Antigravity/User/globalStorage/state.vscdb',
);

function sqliteValue(key: string): string | null {
  if (!existsSync(DB_PATH)) return null;
  try {
    const hex = execFileSync(
      '/usr/bin/sqlite3',
      [DB_PATH, `select hex(value) from ItemTable where key = '${key.replace(/'/g, "''")}' limit 1;`],
      { encoding: 'utf8', timeout: 3000 },
    ).trim();
    if (!hex) return null;
    return Buffer.from(hex, 'hex').toString('utf8');
  } catch {
    return null;
  }
}

function readVarint(buf: Buffer, offset: number): { value: number; next: number } | null {
  let result = 0;
  let shift = 0;
  let index = offset;
  while (index < buf.length) {
    const byte = buf[index++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result, next: index };
    shift += 7;
    if (shift > 49) return null;
  }
  return null;
}

type ProtoField = { field: number; wire: number; value: number | Buffer };

function parseProto(buf: Buffer): ProtoField[] {
  const out: ProtoField[] = [];
  let index = 0;
  while (index < buf.length) {
    const key = readVarint(buf, index);
    if (!key) break;
    index = key.next;
    const field = key.value >> 3;
    const wire = key.value & 0x07;
    if (wire === 0) {
      const value = readVarint(buf, index);
      if (!value) break;
      out.push({ field, wire, value: value.value });
      index = value.next;
    } else if (wire === 2) {
      const length = readVarint(buf, index);
      if (!length) break;
      index = length.next;
      out.push({ field, wire, value: buf.subarray(index, index + length.value) });
      index += length.value;
    } else {
      break;
    }
  }
  return out;
}

function firstString(fields: ProtoField[], field: number): string | undefined {
  const hit = fields.find((entry) => entry.field === field && entry.wire === 2);
  return hit && Buffer.isBuffer(hit.value) ? hit.value.toString('utf8') : undefined;
}

function firstBytes(fields: ProtoField[], field: number): Buffer | undefined {
  const hit = fields.find((entry) => entry.field === field && entry.wire === 2);
  return hit && Buffer.isBuffer(hit.value) ? hit.value : undefined;
}

function firstVarint(fields: ProtoField[], field: number): number | undefined {
  const hit = fields.find((entry) => entry.field === field && entry.wire === 0);
  return hit && typeof hit.value === 'number' ? hit.value : undefined;
}

function extractAsciiStrings(buf: Buffer, minimumLength = 6): string[] {
  const out: string[] = [];
  let current = '';
  for (const byte of buf.values()) {
    if (byte >= 32 && byte <= 126) {
      current += String.fromCharCode(byte);
    } else {
      if (current.length >= minimumLength) out.push(current.trim());
      current = '';
    }
  }
  if (current.length >= minimumLength) out.push(current.trim());
  return out.filter(Boolean);
}

function parsePlanName(authStatusText: string | null): string | undefined {
  if (!authStatusText) return undefined;
  try {
    const auth = JSON.parse(authStatusText) as { userStatusProtoBinaryBase64?: string };
    if (!auth.userStatusProtoBinaryBase64) return undefined;
    const proto = Buffer.from(auth.userStatusProtoBinaryBase64, 'base64');
    const strings = extractAsciiStrings(proto);
    return (
      ['Google AI Ultra', 'Google AI Pro', 'Google AI Standard', 'Google AI Free']
        .find((candidate) => strings.includes(candidate)) ??
      strings.find((value) => value.startsWith('Google AI '))
    );
  } catch {
    return undefined;
  }
}

function parseModelCredits(text: string | null): Pick<AntigravityStatusInfo, 'availableCredits' | 'minimumCreditAmountForUsage'> {
  if (!text) return {};
  try {
    const outer = Buffer.from(text, 'base64');
    const fields = parseProto(outer);
    let availableCredits: number | undefined;
    let minimumCreditAmountForUsage: number | undefined;
    for (const entry of fields) {
      if (entry.field !== 1 || entry.wire !== 2 || !Buffer.isBuffer(entry.value)) continue;
      const pair = parseProto(entry.value);
      const key = firstString(pair, 1);
      const wrapped = firstBytes(pair, 2);
      if (!key || !wrapped) continue;
      const wrappedB64 = firstString(parseProto(wrapped), 1);
      if (!wrappedB64) continue;
      const wrappedFields = parseProto(Buffer.from(wrappedB64, 'base64'));
      const value = firstVarint(wrappedFields, 1) ?? firstVarint(wrappedFields, 2);
      if (value == null) continue;
      if (key === 'availableCreditsSentinelKey') availableCredits = value;
      if (key === 'minimumCreditAmountForUsageKey') minimumCreditAmountForUsage = value;
    }
    return { availableCredits, minimumCreditAmountForUsage };
  } catch {
    return {};
  }
}

function parseSubscriptionActiveUntil(authStatusText: string | null): string | undefined {
  if (!authStatusText) return undefined;
  try {
    const auth = JSON.parse(authStatusText) as {
      subscriptionActiveUntil?: string;
      expiresAt?: string | number;
      expirationTime?: string | number;
      activeUntil?: string;
      userStatusProtoBinaryBase64?: string;
    };
    if (auth.subscriptionActiveUntil) return auth.subscriptionActiveUntil;
    if (auth.expiresAt) return String(auth.expiresAt);
    if (auth.expirationTime) return String(auth.expirationTime);
    if (auth.activeUntil) return auth.activeUntil;

    if (auth.userStatusProtoBinaryBase64) {
      const proto = Buffer.from(auth.userStatusProtoBinaryBase64, 'base64');
      const strings = extractAsciiStrings(proto);
      const datePattern = /^\d{4}-\d{2}-\d{2}/;
      const hit = strings.find((s) => datePattern.test(s));
      if (hit) return hit;
    }
  } catch {}
  return undefined;
}

export function readAntigravityLocalStatus(): AntigravityStatusInfo | undefined {
  const planName = parsePlanName(sqliteValue('antigravityAuthStatus'));
  if (!planName) return undefined;

  const subscriptionActiveUntil = parseSubscriptionActiveUntil(sqliteValue('antigravityAuthStatus'));

  // Remaining model credits live under a separate vscdb key. This is the same
  // local value the Antigravity IDE shows to the user — reading their own local
  // state DB, no Google/Antigravity API call (within ToS).
  const credits = parseModelCredits(sqliteValue('antigravityUnifiedStateSync.modelCredits'));

  return {
    planName,
    availableCredits: credits.availableCredits,
    minimumCreditAmountForUsage: credits.minimumCreditAmountForUsage,
    subscriptionActiveUntil,
  };
}
