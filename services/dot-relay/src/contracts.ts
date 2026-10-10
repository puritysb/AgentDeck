import { Ajv } from 'ajv';
import { DOT_LIMITS, DOT_INTERACTION_KINDS, DOT_INTERACTION_DIRECTIONS, DOT_INTERACTION_STAGES } from '@agentdeck/shared';

export const VERSION = '2026-07-28';
export const EVENT = 'agentdeck.briefing.requested';
export { DOT_LIMITS as LIMITS } from '@agentdeck/shared';


export class Fault extends Error {
  constructor(public code: number, message: string, public reason?: string) { super(message); }
}
export const invalid = (message: string): never => { throw new Fault(-32602, message); };
const id = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[a-zA-Z0-9_.:-]+$' };
const text = (maxLength: number) => ({ type: 'string', maxLength });
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) =>
  ({ type: 'object', properties, required, additionalProperties: false });

export const profileSchema = object({ integrationId: id });
export const eventDefinition = {
  name: EVENT,
  description: 'An explicit user request for a briefing of context shared with AgentDeck.',
  delivery: ['webhook'],
  inputSchema: profileSchema,
  payloadSchema: object({ requestId: id, integrationId: id, expiresAt: { type: 'integer' } }),
};
const requestSchema = object({ requestId: id });
const stamp = { type: 'integer', minimum: 0 };
const claimSchema = object({ attemptId: id, expiresAt: stamp });
const reportSchema = object({ sequence: { type: 'integer', minimum: 1 },
  state: { enum: ['working', 'needs_attention', 'completed', 'failed'] }, summary: text(DOT_LIMITS.reportCharacters), receivedAt: stamp });
export const interactionFields = {
  relationId: id, sequence: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  kind: { enum: [...DOT_INTERACTION_KINDS] }, direction: { enum: [...DOT_INTERACTION_DIRECTIONS] },
  stage: { enum: [...DOT_INTERACTION_STAGES] }, targetRef: { anyOf: [id, { type: 'null' }] },
  summary: text(DOT_LIMITS.interactionSummaryCharacters),
};
export const interactionOutput = object({ ...interactionFields, evidence: { const: 'dot_report' }, receivedAt: stamp });
const requestOutput = object({ interactions: { type: 'array', items: interactionOutput, maxItems: DOT_LIMITS.interactionEvents }, requestId: id, integrationId: id, createdAt: stamp, expiresAt: stamp,
  delivery: { enum: ['local', 'pending', 'accepted', 'failed', 'expired', 'cancelled'] }, attempts: { type: 'integer', minimum: 0 },
  claim: { anyOf: [claimSchema, { type: 'null' }] }, report: { anyOf: [reportSchema, { type: 'null' }] }, expired: { type: 'boolean' } });
export const tools = [
  { name: 'report_interaction', title: 'Report a Dot–agent interaction', read: false,
    description: 'Record request-scoped interaction evidence attributed to Dot. This does not execute controls, confirm the target identity, prove an agent acknowledgement or approve any action. Report only observed stages; do not invent missing transitions.',
    inputSchema: object({ requestId: id, attemptId: id, idempotencyKey: id, ...interactionFields }),
    outputSchema: object({ accepted: { const: true }, sequence: { type: 'integer', minimum: 1 } }) },
  { name: 'get_request', title: 'Read briefing request', outputSchema: requestOutput, description: 'Read the current request and its expiry. No global Dot status is inferred.', inputSchema: requestSchema, read: true },
  { name: 'get_context', title: 'Read shared context', outputSchema: object({ context: text(DOT_LIMITS.contextCharacters), capturedAt: stamp, requestId: id }), description: 'Read only the context explicitly shared for this request, with its capture time.', inputSchema: requestSchema, read: true },
  { name: 'claim_request', title: 'Claim briefing request', outputSchema: claimSchema, description: 'Claim an unexpired request before reporting. Reuse the same idempotency key on retry. Competing claims are refused.', inputSchema: object({ requestId: id, idempotencyKey: id }), read: false },
  { name: 'report_update', title: 'Report briefing progress', outputSchema: object({ accepted: { const: true }, sequence: { type: 'integer', minimum: 1 } }), description: 'Record a bounded report about a claimed request. This is a write, not an OpenAI approval or global Dot control.', inputSchema: object({ requestId: id, attemptId: id, sequence: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, idempotencyKey: id, state: { enum: ['working', 'needs_attention', 'completed', 'failed'] }, summary: text(DOT_LIMITS.reportCharacters) }), read: false },
];
export const schemas = {
  subscribe: object({ name: { const: EVENT }, arguments: profileSchema,
    delivery: object({ mode: { const: 'webhook' }, url: text(DOT_LIMITS.callbackURLCharacters), secret: text(128) }),
    cursor: { type: 'null' }, ttlMs: { anyOf: [{ type: 'integer', minimum: 1000 }, { type: 'null' }] },
  }, ['name', 'arguments', 'delivery']),
  unsubscribe: object({ name: { const: EVENT }, arguments: profileSchema,
    delivery: object({ mode: { const: 'webhook' }, url: text(DOT_LIMITS.callbackURLCharacters) }),
  }),
  create: object({ integrationId: id, idempotencyKey: id, context: text(DOT_LIMITS.contextCharacters), capturedAt: { type: 'integer', minimum: 0 } }),
};
const ajv = new Ajv({ allErrors: false });
const validators = new Map<unknown, ReturnType<typeof ajv.compile>>();
export function validate(schema: object, value: unknown): void {
  let check = validators.get(schema);
  if (!check) { check = ajv.compile(schema); validators.set(schema, check); }
  if (!check(value)) invalid('Input does not match the declared schema');
}
export interface Principal { subject: string; scopes: string[] }
export function requireScope(p: Principal, scope: string): void {
  if (!p.scopes.includes(scope)) throw new Fault(-32003, 'Insufficient scope');
}
