import type { DeckView, SessionSettingsEvent } from '@agentdeck/shared';

/** Called only after the request tracker accepts a correlated response. */
export function settingsPickerAfterResponse(
  view: DeckView,
  event: SessionSettingsEvent,
  operation: 'query' | 'set' | undefined,
): DeckView {
  if (!operation || event.sessionId !== view.openSessionId) return view;
  return {
    ...view,
    page: 0,
    ...(operation === 'set' && !event.error ? { picker: undefined } : {}),
  };
}
