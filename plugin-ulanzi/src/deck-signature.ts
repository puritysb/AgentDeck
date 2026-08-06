/**
 * Compact signature of everything the D200H deck renders from — lets `renderAll`
 * skip the whole rebuild+raster when a daemon broadcast (processing tool-progress
 * churn, an unrelated session's tick) changes nothing visible.
 *
 * This function has one failure mode and it has bitten four times: a field that
 * AFFECTS RENDERING but is MISSING HERE makes two visibly different states
 * compare equal, so the repaint is swallowed and the device keeps showing the
 * old frame — which reads to the user as a dead button, not a stale image. It
 * lives in its own module (rather than inside app.ts, which opens a Studio
 * socket on import) purely so that contract can be tested.
 *
 * Rule for anyone adding a field to the deck: if a cell's pixels or its action
 * can change with it, it belongs in this string.
 */
export function deckSignature(ev: Record<string, unknown>): string {
  // Per-session fields, and why each one is here:
  //  · reviewStatus/reviewRisk/reviewFindings — ride ONLY the session rows, so a
  //    review-only sessions_list compared equal and the REVIEWING flip and
  //    verdict badge never drew (the press felt dead).
  //  · liveAnswerable — the observer discovers a session's tty on a later scan,
  //    and the ask-gate flips it mid-prompt, so it changes on a list that is
  //    otherwise identical; omitted, option cells stay inert until something
  //    unrelated moves.
  //  · question/promptType/askGroupIndex/option labels — one AskUserQuestion
  //    call can hold several questions, and the daemon swaps to the next as each
  //    is answered. That leaves `state` on awaiting_option and `currentTool`
  //    untouched, so without these the second question compares equal and the
  //    deck keeps offering the first — whose indices now mean something else.
  const sessions = ((ev.allSessions as Array<Record<string, unknown>>) ?? [])
    .map((s) => `${s.id}:${s.state ?? ''}:${s.currentTool ?? ''}:${s.modelName ?? ''}`
      + `:${s.reviewStatus ?? ''}:${s.reviewRisk ?? ''}:${s.reviewFindings ?? ''}`
      + `:${s.liveAnswerable ?? ''}:${s.question ?? ''}:${s.promptType ?? ''}`
      + `:${s.askGroupIndex ?? ''}`
      + `:${((s.options as Array<{ label?: string }>) ?? []).map((o) => o.label ?? '').join('/')}`)
    .join(',');
  const opts = ((ev.options as Array<{ label?: string }>) ?? []).map((o) => o.label ?? '').join('/');
  // 5H/7D quota rides usage_update, not state_update — without it here a
  // usage-only change would compare equal and the pinned gauges would never
  // refresh (scheduleRender fires but renderAll early-returns on equal sig).
  const cx = ev.codexRateLimits as { primary?: { usedPercent?: number }; secondary?: { usedPercent?: number } } | undefined;
  const usage = `${ev.fiveHourPercent ?? ''}:${ev.sevenDayPercent ?? ''}:${ev.usageKnown ?? ''}`
    + `:${cx?.primary?.usedPercent ?? ''}:${cx?.secondary?.usedPercent ?? ''}`;
  return [ev.state, ev.mode, ev.focusedSessionId ?? ev.sessionId ?? '', ev.requestId ?? '',
    ev.promptType ?? '', ev.currentTool ?? '', ev.toolInput ?? '', ev.modelName ?? '',
    ev.question ?? '', ev.navigable ?? '', ev.cursorIndex ?? '', opts, usage, sessions].join('|');
}
