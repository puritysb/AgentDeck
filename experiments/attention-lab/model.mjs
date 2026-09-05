// Synthetic replay model only. No production state machine or action dispatcher.
export const scenarios = [
  { id: 'quiet', name: '평상시', note: '다른 일을 하다가 상태를 한 번 확인해보세요.' },
  { id: 'waiting', name: '승인 대기', note: 'API Client가 기다립니다. 여기서 답할 수 있는지 확인해보세요.' },
  { id: 'question', name: '답변 가능', note: '같은 attention 영역이 실제 선택형 질문을 표현할 수 있는지 확인하세요.' },
  { id: 'reply', name: '응답 도착', note: '에이전트의 보고와 검증된 작업 완료를 구분해보세요.' },
  { id: 'offline', name: '연결 끊김', note: '연결이 끊겨도 마지막으로 관측한 대기는 사라지지 않습니다.' },
  { id: 'expired', name: '요청 만료', note: '만료된 질문은 더 이상 답변 가능한 대기가 아닙니다.' },
  { id: 'multiple', name: '동시 대기', note: '다른 세션을 읽는 중 새 대기가 와도 선택이 유지되는지 확인하세요.' },
];
const base = [
  {
    id: 'design',
    project: 'Design System',
    agent: 'Claude Code',
    mark: 'claudecode',
    state: 'working',
    activity: '간격 토큰과 컴포넌트를 확인하고 있습니다.',
    source: '합성 lifecycle 이벤트',
    lastReply: '버튼 간격을 확인했습니다.',
    children: 2,
  },
  {
    id: 'api',
    project: 'API Client',
    agent: 'Codex',
    mark: 'codex',
    state: 'working',
    activity: 'API 테스트를 실행하고 있습니다.',
    source: '합성 lifecycle 이벤트',
    lastReply: '페이지네이션 테스트를 준비했습니다.',
  },
  {
    id: 'docs',
    project: 'Documentation',
    agent: 'OpenCode',
    mark: 'opencode',
    state: 'idle',
    activity: '12분 전 마지막 응답',
    source: '합성 응답 이벤트',
    lastReply: '사용 가이드를 갱신했습니다.',
  },
];
export function createState() {
  return {
    layout: 'C',
    surface: 'desktop',
    count: 5,
    scenario: 'quiet',
    selected: 'api',
    pinned: false,
    connected: true,
    nativeReply: false,
    sessions: [],
    actionLog: [],
    notice: '',
    unread: 0,
    revision: 0,
  };
}
function permission(id, revision) {
  return {
    id: `${id}:permission:${revision}`,
    kind: 'permission',
    text: '테스트 실행 권한을 기다리고 있습니다.',
    detail: '실험 명령: pnpm test · API Client\n실제 하네스가 permission 이벤트를 보냈다고 가정합니다.',
    live: true,
    choices: ['한 번 허용', '거부'],
    source: '합성 PermissionRequest · 표시 전용',
  };
}
function question(id, revision) {
  return {
    id: `${id}:question:${revision}`,
    kind: 'question',
    text: '기존 API 호환성을 유지할까요?',
    detail: '새 응답 형식을 도입하면 기존 클라이언트의 수정이 필요합니다.',
    live: true,
    choices: ['기존 호환성 유지', '새 형식으로 전환'],
    source: '합성 질문 · 직접 답변 가능',
  };
}
export function replay(state, scenario = state.scenario, count = state.count) {
  if (!scenarios.some((s) => s.id === scenario)) throw new Error('Unknown scenario');
  if (![1, 5, 12].includes(count)) throw new Error('Unsupported fixture count');
  const next = {
    ...state,
    count,
    scenario,
    revision: state.revision + 1,
    notice: '',
    unread: 0,
    connected: scenario !== 'offline',
  };
  const sessions = structuredClone(count === 1 ? [base[1]] : base);
  for (let i = sessions.length; i < count; i++) {
    const agents = ['Claude Code', 'Codex', 'OpenCode'];
    const marks = ['claudecode', 'codex', 'opencode'];
    sessions.push({
      id: `extra-${i}`,
      project: i === 3 ? 'API Client' : `Workspace ${i + 1}`,
      agent: agents[i % 3],
      mark: marks[i % 3],
      state: 'idle',
      activity: '마지막 응답 18분 전',
      source: '합성 응답 이벤트',
      lastReply: '다음 요청을 기다립니다.',
    });
  }
  const api = sessions.find((s) => s.id === 'api');
  if (['waiting', 'offline', 'multiple'].includes(scenario)) {
    api.state = 'waiting';
    api.request = permission(api.id, next.revision);
    api.activity = api.request.text;
  }
  if (['question', 'expired'].includes(scenario)) {
    api.request = question(api.id, next.revision);
    api.request.live = scenario !== 'expired';
    api.state = scenario === 'expired' ? 'unknown' : 'waiting';
    api.activity = scenario === 'expired' ? '요청 만료 · 다음 상태는 아직 관측되지 않음' : api.request.text;
  }
  if (scenario === 'reply') {
    api.state = 'idle';
    api.activity = '방금 응답 도착';
    api.lastReply = '테스트를 통과했습니다. 변경 내용을 정리했습니다.';
    next.unread = 1;
  }
  if (scenario === 'multiple' && count > 1) {
    sessions[0].state = 'waiting';
    sessions[0].request = question(sessions[0].id, next.revision);
    sessions[0].activity = sessions[0].request.text;
  }
  next.sessions = sessions;
  if (!sessions.some((s) => s.id === next.selected)) {
    next.selected = api.id;
    next.pinned = false;
  }
  return next;
}
export function selectSession(state, id) {
  return state.sessions.some((s) => s.id === id) ? { ...state, selected: id, pinned: true, notice: '' } : state;
}
export function waitingSessions(state) {
  return state.sessions.filter((s) => s.state === 'waiting' && s.request?.live);
}
export function canAnswer(state, session) {
  return Boolean(
    state.connected &&
    session?.state === 'waiting' &&
    session.request?.live &&
    (session.request.kind === 'question' ||
      (session.request.kind === 'permission' && session.id === 'api' && state.nativeReply)),
  );
}
export function answer(state, sessionId, requestId, choice) {
  const session = state.sessions.find((s) => s.id === sessionId);
  if (!canAnswer(state, session) || session.request.id !== requestId || !session.request.choices.includes(choice)) {
    return { ...state, notice: '현재 유효한 요청이 아닙니다. 답변을 적용하지 않았습니다.' };
  }
  return {
    ...state,
    notice: `모의 응답 적용: ${choice} · 실제 에이전트로 전송하지 않았습니다.`,
    sessions: state.sessions.map((s) =>
      s.id !== sessionId ? s : { ...s, state: 'working', request: undefined, activity: `응답 전달됨: ${choice}` },
    ),
    actionLog: [...state.actionLog, { sessionId, requestId, choice }],
  };
}
export const stateLabels = { working: '작업 중', waiting: '응답 필요', idle: '대기 중', unknown: '상태 미확인' };
