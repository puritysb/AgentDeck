// Public intro rehearsal only: fictional activity through the production WS
// contract. No agent execution, GitHub requests, approval commands or hardware.
const agents = {
  claude: ['claude-code', 'Sample Workspace', 'Claude Sonnet'],
  codex: ['codex-cli', 'Sample API', 'GPT-5 Codex'],
  opencode: ['opencode', 'Sample Documentation', 'Qwen Coder'],
  openclaw: ['openclaw', 'Sample Issue Triage', 'Claude Sonnet'],
  hermes: ['hermes', 'Sample Research', 'GLM-5.3'],
};
const sessions = {};
const phases = [{ at: 0, focus: null, sessions: {}, timeline: null }];
function step(at, agent, state, activity, type, raw, extra = {}) {
  sessions[agent] = { state, activity, ...extra };
  phases.push({ at, focus: null, sessions: structuredClone(sessions), timeline: { agent, type, raw } });
}
step(1000, 'claude', 'processing', 'Adding a searchable session list', 'chat_start', 'Build the sample session search');
step(3000, 'codex', 'processing', 'Testing case-insensitive matching', 'chat_start', 'Write sample search regression tests');
step(5000, 'opencode', 'processing', 'Documenting search shortcuts', 'chat_start', 'Document the sample search workflow');
step(7000, 'openclaw', 'processing', 'Reproducing an empty-result report', 'chat_start', 'Triage the sample empty-result issue');
step(9000, 'hermes', 'processing', 'Reviewing search accessibility notes', 'chat_start', 'Research keyboard and screen-reader checks');
step(12000, 'codex', 'idle', 'Waiting for GitHub Actions', 'tool_exec', 'gh run watch · sample CI queued', { ci: 'queued' });
step(16000, 'codex', 'idle', 'Waiting for GitHub Actions', 'tool_exec', 'Sample CI checks are running', { ci: 'running' });
step(19000, 'hermes', 'idle', 'Accessibility notes ready', 'chat_response', 'Research notes: keyboard focus and empty-result announcements');
step(22000, 'codex', 'idle', 'Sample CI checks passed', 'tool_resolved', 'Sample GitHub Actions checks passed', { ci: 'passed' });
step(26000, 'codex', 'idle', 'Regression tests ready to review', 'chat_response', 'Sample CI complete; regression tests ready');
step(28000, 'claude', 'awaiting_permission', 'Waiting for approval in the source terminal', 'chat_start', 'Permission needed · apply the sample changes', { question: 'Allow the sample search changes?' });
step(32000, 'claude', 'processing', 'Applying changes after source-terminal approval', 'tool_exec', 'Sample changes approved in the source terminal');
step(33500, 'opencode', 'idle', 'Search guide ready', 'chat_response', 'Sample search guide complete');
step(34500, 'openclaw', 'idle', 'Empty results verified', 'chat_response', 'Sample issue reproduction complete');
step(35500, 'claude', 'idle', 'Search ready to review', 'chat_response', 'Sample search implementation complete');

export const showcaseStory = { durationMs: 38000, phases };

export function showcaseEventsForPhase(index, cycleStartedAt, includeHistory, port) {
  const phase = phases[index];
  const rows = Object.entries(phase.sessions).map(([key, value]) => {
    const [agentType, projectName, modelName] = agents[key];
    return {
      id: `showcase-${key}`, port: 0, agentType, projectName, modelName,
      alive: true, controlMode: 'observed', state: value.state, activity: value.activity,
      ...(value.question ? { question: value.question } : {}),
      // Explicit null clears retain-on-absent clients; preserve one invocation
      // identity across queued/running/result. The source run is fictional.
      waitingOn: value.ci ? {
        kind: 'ci', provider: 'github-actions', phase: value.ci,
        agentWaiting: value.ci !== 'passed', evidence: 'github',
        openedAt: cycleStartedAt + 12000,
        checks: { total: 3, passed: value.ci === 'passed' ? 3 : 0, failed: 0, pending: value.ci === 'passed' ? 0 : 3 },
      } : null,
    };
  });
  const primary = rows[0];
  const gatewayConnected = rows.some(row => row.agentType === 'openclaw');
  const timeline = item => {
    const [agentType, projectName] = agents[item.timeline.agent];
    return { ts: cycleStartedAt + item.at, type: item.timeline.type,
      raw: item.timeline.raw, agentType, projectName, sessionId: `showcase-${item.timeline.agent}` };
  };
  return [
    { type: 'state_update', ...(primary ? { ...primary, sessionId: primary.id } : { state: 'idle', agentType: 'daemon', sessionId: 'showcase-hub' }),
      focusedSessionId: '', focusLocked: false, permissionMode: 'default',
      gatewayAvailable: gatewayConnected, gatewayConnected, gatewayHasError: false, daemonPort: port },
    { type: 'sessions_list', sessions: rows },
    ...(includeHistory ? [{ type: 'timeline_history', entries: phases.slice(0, index + 1).filter(item => item.timeline).map(timeline) }]
      : phase.timeline ? [{ type: 'timeline_event', entry: timeline(phase) }] : []),
  ];
}
