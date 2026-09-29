// Website-only rehearsal: real native rendering, fictional coding activity.
// Keep the 30-second App Store scenario unchanged. No actual files are edited,
// commands executed, or permissions answered by this fixture.
const sessions = {};
const phases = [{ at: 0, focus: null, sessions: {}, timeline: null }];
function step(at, agent, state, tool, activity, type, raw, question) {
  sessions[agent] = [state, tool, activity, question];
  phases.push({
    at, focus: null,
    gateway: Boolean(sessions.openclaw),
    sessions: structuredClone(sessions),
    timeline: { agent, type, raw },
    ...(agent === 'codex' ? { usage: { weeklyPercent: 32 + Math.floor(at / 12000) } } : {}),
  });
}
step(1800, 'claude', 'processing', 'Read', 'Building a searchable session list', 'chat_start', 'Add search to the session list');
step(4000, 'claude', 'processing', 'Read', 'Reading SessionList.swift', 'tool_exec', 'Read · SessionList.swift');
step(6000, 'codex', 'processing', 'Test', 'Writing search regression tests', 'chat_start', 'Test project and agent name matching');
step(8200, 'claude', 'processing', 'Edit', 'Adding the search field', 'tool_exec', 'Edit · search field and empty results');
step(10500, 'claude2', 'processing', 'Grep', 'Checking contrast and narrow layouts', 'chat_start', 'Check search accessibility');
step(13000, 'codex', 'processing', 'Test', 'Testing case-insensitive matching', 'tool_exec', 'Test · mixed case and empty queries');
step(15500, 'opencode', 'processing', 'Write', 'Documenting search shortcuts', 'chat_start', 'Document the new search workflow');
step(18000, 'claude2', 'processing', 'Edit', 'Keeping search readable on small screens', 'tool_exec', 'Edit · compact layout and contrast');
step(20500, 'openclaw', 'processing', 'Read', 'Reproducing an empty-result report', 'chat_start', 'Reproduce search with no results');
step(23000, 'codex', 'processing', 'Test', 'Checking keyboard focus after clearing', 'tool_exec', 'Test · focus returns to the session list');
step(25500, 'claude', 'awaiting_permission', 'Edit', 'Waiting for permission in the source terminal', 'chat_start', 'Permission needed · apply the search changes', 'Allow the search layout changes?');
step(28500, 'opencode', 'idle', undefined, 'Search guide ready', 'chat_response', 'Search guide and shortcuts are ready');
step(31500, 'claude', 'processing', 'Edit', 'Applying changes after terminal approval', 'tool_exec', 'Edit · search changes approved in terminal');
step(34000, 'claude2', 'idle', undefined, 'Accessibility review complete', 'chat_response', 'Contrast and narrow layouts checked');
step(36500, 'codex', 'idle', undefined, 'Search regression tests passed', 'chat_response', 'Search, clear, and keyboard tests passed');
step(39000, 'openclaw', 'idle', undefined, 'Empty results verified', 'chat_response', 'Empty results now explain what to try next');
step(41500, 'claude', 'idle', undefined, 'Search is ready to review', 'chat_response', 'Search implementation ready for review');
export const aquariumStory = { durationMs: 46000, phases };
