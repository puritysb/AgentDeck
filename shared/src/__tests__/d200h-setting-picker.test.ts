// #463: the D200H opens OpenClaw's own MODEL / THINKING values as a picker.
// Values, labels and the default come from the agent's `session_settings`
// answer only; a choice is sent back verbatim (null = back to the default).
import { describe, it, expect } from 'vitest';
import { buildSessionDeck, type DeckAction, type DeckView } from '../d200h-layout.js';

const POSITIONS = ['0_0', '1_0', '2_0', '3_0', '4_0', '0_1', '1_1', '2_1'];
const SID = 'openclaw-gateway';
const LEVELS = ['off', 'low', 'medium', 'high'].map((id) => ({ id }));
const SETTINGS = { settings: [{ key: 'effort' as const, current: 'medium', default: 'high', options: LEVELS }] };

function evt() {
  return {
    type: 'state_update', state: 'idle', focusedSessionId: SID,
    allSessions: [{ id: SID, port: 18789, alive: true, projectName: 'OpenClaw', agentType: 'openclaw', controlMode: 'managed', state: 'idle', modelName: 'zai/glm-5.3' }],
  };
}
function deck(view: Partial<DeckView>) {
  return buildSessionDeck(evt(), { mode: 'detail', openSessionId: SID, ...view }, POSITIONS);
}
const actions = (cells: Map<string, { action: DeckAction }>) => [...cells.values()].map((c) => c.action);

describe('D200H agent-native setting picker', () => {
  it('OpenClaw idle leads with MODEL and THINKING tiles that open the picker', () => {
    const cells = deck({ settings: SETTINGS });
    expect(actions(cells)).toContainEqual({ kind: 'picker-open', key: 'model' });
    expect(actions(cells)).toContainEqual({ kind: 'picker-open', key: 'effort' });
    expect([...cells.values()].map((c) => c.svg).join('')).toContain('medium');
  });

  it('shows LOADING until the agent answers, then DEFAULT + every offered level', () => {
    const loading = deck({ picker: 'effort' });
    expect([...loading.values()].map((c) => c.svg).join('')).toContain('LOADING');
    const cells = deck({ picker: 'effort', settings: SETTINGS });
    // BACK closes the picker instead of leaving the session.
    expect(cells.get('0_0')?.action).toEqual({ kind: 'picker-close' });
    const commands = actions(cells).filter((a): a is Extract<DeckAction, { kind: 'setting-select' }> => a?.kind === 'setting-select');
    expect(commands[0]).toEqual({ kind: 'setting-select', sessionId: SID, key: 'effort', value: null });
    expect(commands.slice(1).map((c) => c.value)).toEqual(['off', 'low', 'medium', 'high']);
  });

  it('disables choices while saving and shows mutation refusals with offered values retained', () => {
    const saving = deck({ picker: 'effort', settings: { ...SETTINGS, pending: 'set' } });
    expect([...saving.values()].map(c => c.svg).join('')).toContain('SAVING');
    expect(actions(saving).some(a => a?.kind === 'setting-select')).toBe(false);
    const refused = deck({ picker: 'effort', settings: { ...SETTINGS, error: 'not allowed' } });
    expect([...refused.values()].map(c => c.svg).join('')).toContain('REFUSED');
    expect([...refused.values()].map(c => c.svg).join('')).toContain('not allowed');
    expect(actions(refused).some(a => a?.kind === 'setting-select')).toBe(true);
  });

  it('surfaces the agent\'s refusal and never offers a value it did not list', () => {
    const cells = deck({ picker: 'model', settings: { settings: [], error: 'model not allowed' } });
    const svg = [...cells.values()].map((c) => c.svg).join('');
    expect(svg).toContain('UNAVAILABLE');
    expect(svg).toContain('model not allowed');
    expect(actions(cells).some((a) => a?.kind === 'setting-select')).toBe(false);
  });
});
