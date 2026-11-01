import type { SessionInfo } from './protocol.js';
import { OPENCODE_PERMISSION_CHOICES } from './opencode-question.js';

/** Controller presentation SSOT. Key sizes are SVG units on a 144-unit key. */
export const DEVICE_CONTROLLER_RULES = {
  observedInputAgents: ['claude-code', 'opencode'],
  key: { canvas: 144, optionFont: 22, optionLine: 25, optionWidth: 132, optionLines: 3, questionFont: 16 },
  compact: { questionBytes: 159, requestBytes: 39, optionLabelBytes: 63, options: 6 },
  permissionChoices: OPENCODE_PERMISSION_CHOICES,
} as const;

/** User-authored input needs an actual delivery path, never an inferred agent. */
export function hasControllerInput(session: SessionInfo | undefined): boolean {
  if (session?.alive !== true || session.controllerInput === false) return false;
  return session.controlMode === 'managed' || (session.controlMode !== 'observed' && Number.isFinite(session.port) && session.port > 0)
    || session.agentType === 'openclaw'
    || (session.controlMode === 'observed' && (DEVICE_CONTROLLER_RULES.observedInputAgents as readonly string[]).includes(session.agentType ?? ''));
}

/** Compact displays must not approve a subject they could not receive intact. */
export function compactControllerCapabilities(session: SessionInfo): { controllerInput: boolean; controllerAnswerable: boolean } {
  const limits = DEVICE_CONTROLLER_RULES.compact;
  const bytes = (text: string | undefined) => new TextEncoder().encode(typeof text === 'string' ? text : '').length;
  return {
    controllerInput: hasControllerInput(session),
    controllerAnswerable: hasControllerAnswer(session) && (session.question == null || typeof session.question === 'string')
      && bytes(session.question) <= limits.questionBytes && bytes(session.requestId) <= limits.requestBytes
      && (!Array.isArray(session.options) || (session.options.length <= limits.options
        && session.options.every(option => typeof option?.label === 'string' && bytes(option.label) <= limits.optionLabelBytes))),
  };
}

/** Missing capability is not permission to invent a yes/no answer. */
export function hasControllerAnswer(session: SessionInfo): boolean {
  const managed = session.controlMode === 'managed' || (session.controlMode !== 'observed' && Number.isFinite(session.port) && session.port > 0);
  const request = typeof session.requestId === 'string' ? session.requestId : '';
  const held = !!request && (!request.startsWith('ocperm:') || session.liveAnswerable === true);
  const live = typeof session.liveAnswerable === 'boolean' ? session.liveAnswerable : managed;
  return session.alive === true && typeof session.state === 'string' && session.state.startsWith('awaiting_')
    && (held || (live && Array.isArray(session.options) && session.options.length > 0));
}
