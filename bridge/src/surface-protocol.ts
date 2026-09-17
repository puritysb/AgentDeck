import { createRequire } from 'node:module';
import { ESP32_BOARDS } from '@agentdeck/shared';

export const SURFACE_PROTOCOL_MAJOR = 1 as const;
export const PORTABLE_READER_PROFILE = 'portable-reader/v1' as const;
export const OTA_RESUME_PARTIAL_CAPABILITY = 'ota.resume-206' as const;
export const CLAUDE_TOOL_EVENTS_CAPABILITY = 'timeline.tool-events.read' as const;
export const AGENTDECK_FIRMWARE_PRODUCT_ID = 'dev.agentdeck.dashboard-firmware' as const;
export const POCKET_DAILY_PRODUCT_ID = 'io.pocketdaily.reader' as const;

const packageJson = createRequire(import.meta.url)('../package.json') as { version: string };
export const SURFACE_SERVER_VERSION = packageJson.version;

const PROFILE_CAPABILITIES = {
  'dashboard-live/v1': new Set([
    'sessions.read', 'usage.read', 'timeline.read', CLAUDE_TOOL_EVENTS_CAPABILITY, 'display-state.read',
  ]),
  'companion-control/v1': new Set([
    'sessions.read', 'usage.read', 'session.focus', 'permission.decide',
    'prompt.select', 'session.prompt', 'session.interrupt', 'session.escape', 'review.run',
  ]),
  [PORTABLE_READER_PROFILE]: new Set([
    'feed.pull', 'feed.conditional', 'outbox.push', 'glance.read',
    'weather.snapshot.read', 'weather.cues.display', 'weather.cues.notify',
    'learning.pack.read', 'learning.pack.update',
    'font.pack.read', 'font.pack.update',
    'ota.feed', OTA_RESUME_PARTIAL_CAPABILITY, 'device.telemetry',
    // Deliberately no inbox.ws until the public invalidation runtime exists.
  ]),
  'display-only/v1': new Set([
    'sessions.read', 'usage.read', 'timeline.read', CLAUDE_TOOL_EVENTS_CAPABILITY, 'display-state.read',
  ]),
} as const;

export type SurfaceProfileId = keyof typeof PROFILE_CAPABILITIES;

interface SurfaceProductRule {
  profiles: ReadonlySet<SurfaceProfileId>;
  boards: ReadonlySet<string> | '*';
  channels: ReadonlySet<string>;
}

const PRODUCT_RULES: Record<string, SurfaceProductRule> = {
  [POCKET_DAILY_PRODUCT_ID]: {
    profiles: new Set([PORTABLE_READER_PROFILE]),
    boards: new Set(['xteink_x3', 'xteink_x4']),
    channels: new Set(['stable']),
  },
  [AGENTDECK_FIRMWARE_PRODUCT_ID]: {
    profiles: new Set([PORTABLE_READER_PROFILE]),
    boards: new Set(ESP32_BOARDS.map((board) => board.id)),
    channels: new Set(['stable']),
  },
};

const HEADER_NAMES = {
  protocol: 'agentdeck-surface-protocol',
  profile: 'agentdeck-surface-profile',
  clientId: 'agentdeck-client-id',
  clientVersion: 'agentdeck-client-version',
  productId: 'agentdeck-product-id',
  capabilities: 'agentdeck-capabilities',
  board: 'agentdeck-board',
  updateChannel: 'agentdeck-update-channel',
} as const;

export interface SurfaceIdentity {
  protocol: 1;
  profile: SurfaceProfileId;
  clientId: string;
  clientVersion: string;
  productId: string;
  capabilities: string[];
  board: string;
  updateChannel: string;
}

export interface SurfaceOffer {
  protocol?: unknown;
  clientId?: unknown;
  clientVersion?: unknown;
  productId?: unknown;
  profiles?: unknown;
}

export interface SurfaceWelcome {
  type: 'surface_welcome';
  protocol: 1;
  profile: SurfaceProfileId;
  capabilities: string[];
  serverVersion: string;
}

export interface SurfaceNegotiation {
  clientId: string;
  clientVersion: string;
  productId: string;
  profile: SurfaceProfileId;
  capabilities: string[];
  welcome: SurfaceWelcome;
}

export class SurfaceProtocolError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type HeaderRecord = Record<string, string | string[] | undefined>;

function header(headers: HeaderRecord, name: string): string | undefined {
  const raw = headers[name];
  if (Array.isArray(raw)) return raw.length === 1 ? raw[0]?.trim() : undefined;
  return typeof raw === 'string' ? raw.trim() : undefined;
}

function boundedToken(value: string, label: string, max = 128): string {
  if (!value || value.length > max || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new SurfaceProtocolError(400, 'surface_identity_invalid', `${label} is malformed`);
  }
  return value;
}

function knownProfile(value: string): SurfaceProfileId {
  if (!Object.prototype.hasOwnProperty.call(PROFILE_CAPABILITIES, value)) {
    throw new SurfaceProtocolError(406, 'surface_profile_unsupported', `Surface profile "${value}" is not supported`);
  }
  return value as SurfaceProfileId;
}

function capabilityIntersection(profile: SurfaceProfileId, offered: unknown): string[] {
  if (!Array.isArray(offered)) return [];
  const known = PROFILE_CAPABILITIES[profile] as ReadonlySet<string>;
  const out: string[] = [];
  for (const value of offered) {
    if (typeof value !== 'string' || !known.has(value) || out.includes(value)) continue;
    out.push(value);
  }
  return out;
}

export interface SurfaceOtaIdentity {
  productId: string;
  board: string;
  updateChannel: string;
}

function validateProductTuple(identity: Pick<SurfaceIdentity, 'productId' | 'profile' | 'board' | 'updateChannel'>): void {
  const rule = PRODUCT_RULES[identity.productId];
  if (!rule) {
    throw new SurfaceProtocolError(422, 'surface_product_unsupported', `Surface product "${identity.productId}" is not registered`);
  }
  if (!rule.profiles.has(identity.profile)) {
    throw new SurfaceProtocolError(409, 'surface_product_profile_mismatch', 'Surface product and profile do not match');
  }
  if (rule.boards !== '*' && !rule.boards.has(identity.board)) {
    throw new SurfaceProtocolError(409, 'surface_product_board_mismatch', 'Surface product and board do not match');
  }
  if (!rule.channels.has(identity.updateChannel)) {
    throw new SurfaceProtocolError(409, 'surface_product_channel_mismatch', 'Surface product and update channel do not match');
  }
}

/** Validate an OTA namespace independently of an HTTP request. Staging and
 * serving both call this so a product-aware image can never fall back to a
 * board-only namespace. */
export function validateSurfaceOtaIdentity(identity: SurfaceOtaIdentity): SurfaceOtaIdentity {
  const bounded = {
    productId: boundedToken(identity.productId, 'productId'),
    board: boundedToken(identity.board, 'board', 96),
    updateChannel: boundedToken(identity.updateChannel, 'updateChannel', 48),
  };
  validateProductTuple({ ...bounded, profile: PORTABLE_READER_PROFILE });
  return bounded;
}

/** Parse the all-or-nothing HTTP Surface declaration. No Surface headers is
 * the legacy baseline; one or more headers means all eight must be valid. */
export function parseHttpSurfaceIdentity(
  headers: HeaderRecord,
  requiredCapability?: string,
): SurfaceIdentity | undefined {
  const values = Object.fromEntries(
    Object.entries(HEADER_NAMES).map(([key, name]) => [key, header(headers, name)]),
  ) as Record<keyof typeof HEADER_NAMES, string | undefined>;
  const present = Object.values(values).filter((value) => value !== undefined).length;
  if (present === 0) return undefined;
  if (present !== Object.keys(HEADER_NAMES).length) {
    throw new SurfaceProtocolError(400, 'surface_identity_incomplete', 'All eight AgentDeck Surface identity headers are required');
  }
  if (values.protocol !== String(SURFACE_PROTOCOL_MAJOR)) {
    throw new SurfaceProtocolError(426, 'surface_protocol_unsupported', `Surface protocol ${values.protocol} is not supported`);
  }
  const profile = knownProfile(values.profile!);
  if (profile !== PORTABLE_READER_PROFILE) {
    throw new SurfaceProtocolError(406, 'surface_profile_route_mismatch', 'This HTTP route requires portable-reader/v1');
  }
  const offeredCapabilities = values.capabilities!.split(',').map((value) => value.trim()).filter(Boolean);
  const capabilities = capabilityIntersection(profile, offeredCapabilities);
  if (requiredCapability && !capabilities.includes(requiredCapability)) {
    throw new SurfaceProtocolError(403, 'surface_capability_required', `Capability "${requiredCapability}" was not granted`);
  }
  const identity: SurfaceIdentity = {
    protocol: SURFACE_PROTOCOL_MAJOR,
    profile,
    clientId: boundedToken(values.clientId!, 'AgentDeck-Client-Id'),
    clientVersion: boundedToken(values.clientVersion!, 'AgentDeck-Client-Version', 96),
    productId: boundedToken(values.productId!, 'AgentDeck-Product-Id'),
    capabilities,
    board: boundedToken(values.board!, 'AgentDeck-Board', 96),
    updateChannel: boundedToken(values.updateChannel!, 'AgentDeck-Update-Channel', 48),
  };
  validateProductTuple(identity);
  return identity;
}

/** Select the resumable OTA response shape without guessing from a client
 * version. Legacy clients append `?from=` bodies but only accept status 200;
 * negotiated clients explicitly opt into the standard 206 response. */
export function pullOtaResponseStatus(
  from: number,
  identity: Pick<SurfaceIdentity, 'capabilities'> | undefined,
): 200 | 206 {
  return from > 0 && identity?.capabilities.includes(OTA_RESUME_PARTIAL_CAPABILITY) === true
    ? 206 : 200;
}

/** A product-aware request may repeat the tuple in the query, but repetition
 * is correlation, not override: every supplied member must match the headers. */
export function validateSurfaceQueryTuple(identity: SurfaceIdentity, params: URLSearchParams): void {
  const query = {
    productId: params.get('productId'),
    board: params.get('board'),
    updateChannel: params.get('updateChannel'),
  };
  for (const [field, value] of Object.entries(query)) {
    if (value !== null && value !== identity[field as keyof typeof query]) {
      throw new SurfaceProtocolError(409, 'surface_query_identity_mismatch', `Query ${field} does not match Surface identity`);
    }
  }
}

export function negotiateSurface(offer: SurfaceOffer): SurfaceNegotiation {
  if (offer.protocol !== SURFACE_PROTOCOL_MAJOR) {
    throw new SurfaceProtocolError(426, 'surface_protocol_unsupported', `Surface protocol ${String(offer.protocol)} is not supported`);
  }
  const clientId = boundedToken(String(offer.clientId ?? ''), 'surface.clientId');
  const clientVersion = boundedToken(String(offer.clientVersion ?? ''), 'surface.clientVersion', 96);
  const productId = boundedToken(String(offer.productId ?? ''), 'surface.productId');
  if (!Array.isArray(offer.profiles) || offer.profiles.length === 0) {
    throw new SurfaceProtocolError(406, 'surface_profile_unsupported', 'At least one Surface profile offer is required');
  }
  let selected: { id: SurfaceProfileId; capabilities: string[] } | undefined;
  for (const raw of offer.profiles) {
    if (!raw || typeof raw !== 'object') continue;
    const profile = raw as { id?: unknown; capabilities?: unknown };
    if (typeof profile.id !== 'string' || !Object.prototype.hasOwnProperty.call(PROFILE_CAPABILITIES, profile.id)) continue;
    const id = profile.id as SurfaceProfileId;
    selected = { id, capabilities: capabilityIntersection(id, profile.capabilities) };
    break;
  }
  if (!selected) {
    throw new SurfaceProtocolError(406, 'surface_profile_unsupported', 'No offered Surface profile is supported');
  }
  if (selected.id === PORTABLE_READER_PROFILE) {
    const rule = PRODUCT_RULES[productId];
    if (!rule || !rule.profiles.has(selected.id)) {
      throw new SurfaceProtocolError(422, 'surface_product_unsupported', 'Portable-reader product is not registered');
    }
  }
  return {
    clientId,
    clientVersion,
    productId,
    profile: selected.id,
    capabilities: selected.capabilities,
    welcome: {
      type: 'surface_welcome',
      protocol: SURFACE_PROTOCOL_MAJOR,
      profile: selected.id,
      capabilities: selected.capabilities,
      serverVersion: SURFACE_SERVER_VERSION,
    },
  };
}

export function surfaceErrorBody(error: SurfaceProtocolError): { error: string; message: string } {
  return { error: error.code, message: error.message };
}

export function isPortableReaderProfile(profile: string | undefined): boolean {
  return profile === PORTABLE_READER_PROFILE;
}

/** Public WS event boundary for a negotiated profile. The portable profile is
 * deliberately pull-first and does not inherit private dashboard broadcasts. */
export function surfaceAllowsEvent(profile: SurfaceProfileId, eventType: string): boolean {
  if (profile !== PORTABLE_READER_PROFILE) return true;
  return eventType === 'surface_welcome' || eventType === 'connection' || eventType === 'device_info_request';
}

export function surfaceHasCapability(surface: SurfaceNegotiation | undefined, capability: string): boolean {
  return surface?.capabilities.includes(capability) ?? false;
}

/** Additive projection switch: negotiated headers are preferred, while the
 * historical query remains valid for old Pocket builds. */
export function usesPortableReaderProjection(
  identity: SurfaceIdentity | undefined,
  params: URLSearchParams,
): boolean {
  return identity !== undefined || params.get('surface') === 'pocket-reader';
}
