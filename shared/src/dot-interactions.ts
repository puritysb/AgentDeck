/** Reported relationships are evidence, never authority to execute or approve an action. */
export const DOT_INTERACTION_KINDS = ['delegation', 'message', 'control', 'result', 'attention'] as const;
export const DOT_INTERACTION_DIRECTIONS = ['dot_to_agent', 'agent_to_dot'] as const;
export const DOT_INTERACTION_STAGES = ['requested', 'delivered', 'accepted', 'running', 'needs_attention', 'completed', 'failed', 'cancelled'] as const;
export const DOT_INTERACTION_RANK: Record<typeof DOT_INTERACTION_STAGES[number], number> = {
  requested: 0, delivered: 1, accepted: 2, running: 3, needs_attention: 3, completed: 4, failed: 4, cancelled: 4,
};
export const DOT_INTERACTION_TERMINAL = ['completed', 'failed', 'cancelled'] as const;
export interface DotInteraction {
  relationId: string; sequence: number; kind: typeof DOT_INTERACTION_KINDS[number];
  direction: typeof DOT_INTERACTION_DIRECTIONS[number]; stage: typeof DOT_INTERACTION_STAGES[number];
  targetRef: string | null; summary: string;
  evidence: 'dot_report'; receivedAt: number;
}
export function dotInteractionTransition(prior: DotInteraction | undefined, next: DotInteraction): boolean {
  if (!Object.hasOwn(DOT_INTERACTION_RANK, next.stage)) return false;
  if (!prior) return true; // Missing earlier stages are not fabricated.
  return next.sequence > prior.sequence && next.kind === prior.kind && next.direction === prior.direction
    && next.targetRef === prior.targetRef && !DOT_INTERACTION_TERMINAL.some(s => s === prior.stage)
    && DOT_INTERACTION_RANK[next.stage] >= DOT_INTERACTION_RANK[prior.stage];
}
export function dotInteractionLabel(value: DotInteraction): string {
  const target = value.targetRef ? `Unverified target ${value.targetRef}` : 'Unknown target';
  const edge = value.direction === 'dot_to_agent' ? `Dot → ${target}` : `${target} → Dot`;
  return `${value.kind} · ${value.stage} · ${edge} · Dot report`;
}
