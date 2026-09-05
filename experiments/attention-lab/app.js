import {
  scenarios,
  createState,
  replay,
  selectSession,
  waitingSessions,
  canAnswer,
  answer,
  stateLabels,
} from './model.mjs';

let state = replay(createState());
let playback;
const $ = (id) => document.getElementById(id);
const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const layouts = {
  A: ['Habitat', '테라리움은 유지하고, 개입 영역을 분리합니다.'],
  B: ['Work list', '공간 은유 없이, 세션과 대기만으로 충분한지 봅니다.'],
  C: ['Quiet overview', '존재감은 얕게, 선택한 맥락은 한 자리에 둡니다.'],
};
const mark = (s) => `<span class="agent-mark ${s.mark}" aria-hidden="true"></span>`;
const badge = (s) =>
  `<span class="status ${state.connected ? s.state : 'unknown'}"><i></i>${state.connected ? stateLabels[s.state] : '마지막 관측 · ' + stateLabels[s.state]}</span>`;
const sessionButton = (s, habitat = false) =>
  `<button class="${habitat ? 'inhabitant' : 'session-row'} ${s.id === state.selected ? 'selected' : ''}" data-session="${s.id}" aria-pressed="${s.id === state.selected}">${mark(s)}<span class="session-name"><strong>${escape(s.project)}</strong><small>${escape(s.agent)} · ${s.id}</small></span>${badge(s)}${!habitat ? `<span class="row-activity">${escape(s.activity)}</span>` : ''}</button>`;

function attention() {
  const waiting = waitingSessions(state);
  return `<div class="attention-strip ${waiting.length ? 'needs-attention' : ''}"><span class="attention-title">${!state.connected ? '연결 끊김' : waiting.length ? `${waiting.length}개 세션에 응답 필요` : '지금 응답을 기다리는 세션 없음'}</span><span>${!state.connected ? '아래 대기는 마지막 관측입니다. 현재 상태를 확인할 수 없습니다.' : waiting.length ? '직접 선택할 때만 맥락이 바뀝니다.' : state.unread ? '새 응답 1개 · 작업 완료를 뜻하지 않습니다.' : '다른 일에 집중해도 괜찮습니다.'}</span>${waiting.length ? `<div class="waiting-links">${waiting.map((s) => `<button data-session="${s.id}">${escape(s.project)} <small>${s.id}</small> ↗</button>`).join('')}</div>` : ''}</div>`;
}

function context() {
  const s = state.sessions.find((s) => s.id === state.selected);
  const req = s.request;
  let content;
  if (req) {
    const enabled = canAnswer(state, s);
    const reason = !state.connected
      ? '오프라인 · 현재 요청의 유효성을 확인할 수 없습니다.'
      : !req.live
        ? '만료된 요청 · 답변할 수 없습니다.'
        : !enabled
          ? '감지는 가능하지만, 이 하네스의 직접 응답 경로는 연결되지 않았습니다.'
          : '이 요청은 아래에서 답변할 수 있습니다. 이 실험에서는 로컬 상태만 바뀝니다.';
    content = `<div class="request ${enabled ? 'answerable' : ''}"><span class="eyebrow">${!req.live ? 'EXPIRED REQUEST' : enabled ? 'YOUR RESPONSE' : 'OBSERVED REQUEST'}</span><h3>${escape(req.text)}</h3><p class="request-detail">${escape(req.detail)}</p><p class="source">${req.kind === 'permission' && state.nativeReply ? '합성 PermissionRequest · 직접 응답 API 가정' : escape(req.source)}</p><div class="response-path"><span class="path-dot"></span>${reason}</div>${enabled ? `<div class="answer-options">${req.choices.map((choice) => `<button class="answer" data-answer="${escape(choice)}" data-request="${req.id}" data-target="${s.id}">${escape(choice)} <span>→</span></button>`).join('')}</div>` : `<button class="native-link" data-origin="${s.id}">원래 세션에서 확인 ↗ <small>경로 안내</small></button>`}</div>`;
  } else {
    content = `<div class="quiet-context"><span class="eyebrow">${state.scenario === 'reply' && s.id === 'api' ? 'NEW RESPONSE' : 'LAST CONTEXT'}</span><h3>${state.scenario === 'reply' && s.id === 'api' ? '응답이 도착했습니다.' : s.state === 'working' ? '진행 중입니다.' : '마지막 맥락이 남아 있습니다.'}</h3><p>${escape(s.activity)}</p><blockquote>${escape(s.lastReply)}</blockquote><p class="source">에이전트의 마지막 보고 · 완료 여부는 별도 확인이 필요합니다.</p></div>`;
  }
  return `<aside class="context-panel" aria-label="선택한 세션의 맥락"><div class="panel-title"><span class="eyebrow">CONTEXT</span><span>${state.pinned ? '선택 유지 중' : '선택한 세션'}</span></div><div class="context-identity">${mark(s)}<div><h2>${escape(s.project)}</h2><p>${escape(s.agent)} <span>· ${s.id}</span></p></div></div>${badge(s)}${content}<div class="context-footer"><span>이벤트 출처</span><p>${escape(s.source)}</p>${s.children ? '<p>하위 에이전트 2개 · 세부 상태는 이 실험에서 제공하지 않음</p>' : ''}<p>세션 ID와 요청 ID로 대상을 구분합니다.</p></div></aside>`;
}

function habitat(shallow = false) {
  return `<section class="habitat ${shallow ? 'shallow' : ''}"><div class="habitat-caption"><span class="eyebrow">SHARED PRESENCE</span><span>고정 위치 · 높이와 움직임은 진행률이 아닙니다</span></div><div class="inhabitants">${state.sessions.map((s) => sessionButton(s, true)).join('')}</div><div class="habitat-floor"><span>관측한 상태만 표시</span><span>${state.sessions.length} sessions</span></div></section>`;
}

function desktop() {
  const list = `<section class="work-list"><div class="list-heading"><h2>세션</h2><span>수동 선택 · 고정 순서</span></div>${state.sessions.map((s) => sessionButton(s)).join('')}</section>`;
  if (state.layout === 'A')
    return `<div class="workspace layout-a"><div class="primary-region">${habitat()}</div>${context()}</div>`;
  if (state.layout === 'B') return `<div class="workspace layout-b">${list}${context()}</div>`;
  return `<div class="workspace layout-c"><div class="primary-region">${habitat(true)}${list}</div>${context()}</div>`;
}

function eink() {
  return `<div class="surface-explainer"><strong>E-ink · 읽기 중심 투영</strong><span>모노크롬 · 애니메이션 없음 · 레이아웃 근사, 실제 기기 렌더링 아님</span></div><div class="eink-sheet">${state.layout === 'A' ? habitat(true) : ''}<div class="eink-columns"><section class="work-list"><div class="list-heading"><h2>세션 ${state.count}</h2><span>고정 순서</span></div>${state.sessions.map((s) => sessionButton(s)).join('')}</section>${context()}</div></div><p class="surface-note">웹 실험의 클릭은 세션 탐색용입니다. 터치·물리 키 지원과 새로고침 비용은 실제 기기에서 따로 검증해야 합니다.${state.layout === 'C' ? ' C의 공간 표현은 이 표면에서 생략합니다.' : ''}</p>`;
}

function deck() {
  return `<div class="surface-explainer"><strong>키 데크 · 고정된 위치</strong><span>15키 형태의 탐색 실험 · 이벤트가 도착해도 키의 대상은 바뀌지 않음</span></div><div class="deck-workspace"><div><div class="key-deck">${state.sessions.map((s) => `<button class="deck-key ${s.id === state.selected ? 'selected' : ''}" data-session="${s.id}" aria-pressed="${s.id === state.selected}">${mark(s)}<strong>${escape(s.project)}</strong><small>${s.id} · ${escape(s.agent)}</small>${badge(s)}</button>`).join('')}${Array.from({ length: 12 - state.count }, () => '<div class="deck-key vacant" aria-hidden="true">—</div>').join('')}<button class="deck-key reserved" data-overview="true">개요<span>선택 유지</span></button><div class="deck-key reserved">응답 필요<strong>${waitingSessions(state).length}</strong></div><div class="deck-key reserved">연결<span>${state.connected ? '합성 · 연결됨' : '마지막 관측'}</span></div></div><p class="surface-note">${state.layout}안의 공간 배치를 축소하지 않고 공통 상태만 투영합니다. 오른쪽은 동반 맥락 화면의 가설이며, 실제 플러그인 UI가 아닙니다.</p></div>${context()}</div>`;
}

function render(announcement = '') {
  const focused = document.activeElement;
  const focusKey = focused?.dataset.session;
  const focusGroup = focused?.classList.contains('session-row')
    ? '.session-row'
    : focused?.classList.contains('inhabitant')
      ? '.inhabitant'
      : focused?.classList.contains('deck-key')
        ? '.deck-key'
        : '.waiting-links button';
  $('layouts').innerHTML = Object.entries(layouts)
    .map(
      ([id, [name]]) =>
        `<button data-layout="${id}" aria-pressed="${state.layout === id}"><b>${id}</b> ${name}</button>`,
    )
    .join('');
  $('scenarios').innerHTML = scenarios
    .map((s) => `<button data-scenario="${s.id}" aria-pressed="${state.scenario === s.id}">${s.name}</button>`)
    .join('');
  $('scenario-note').textContent = scenarios.find((s) => s.id === state.scenario).note;
  $('surface').value = state.surface;
  $('count').value = state.count;
  $('native-reply').checked = state.nativeReply;
  $('hypothesis').textContent = layouts[state.layout][1];
  $('trace').textContent = `선택: ${state.selected} · 모의 응답 ${state.actionLog.length}회 · 실제 전송 0회`;
  $('preview').className = `surface-${state.surface}`;
  $('preview').innerHTML =
    `<div class="product-header"><div><span class="eyebrow">AGENTDECK / ${state.layout}</span><h1>${layouts[state.layout][0]}</h1></div><div class="connection ${!state.connected ? 'offline' : ''}"><i></i>${state.connected ? '합성 데이터 연결' : '연결 끊김 · 마지막 상태 보존'}</div></div>${attention()}${state.surface === 'desktop' ? desktop() : state.surface === 'eink' ? eink() : deck()}${state.notice ? `<p class="notice" role="status">${escape(state.notice)}</p>` : ''}`;
  if (focusKey) $('preview').querySelector(`${focusGroup}[data-session="${focusKey}"]`)?.focus({ preventScroll: true });
  if (announcement) $('live').textContent = announcement;
}
function stop() {
  clearInterval(playback);
  playback = undefined;
  $('play').textContent = '▶ 순서대로 재생';
}
document.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  const { layout, scenario, session, answer: choice, target, request, origin, overview } = button.dataset;
  if (layout) {
    state.layout = layout;
    render();
    $('layouts').querySelector(`[data-layout="${layout}"]`).focus();
  }
  if (scenario) {
    stop();
    state = replay(state, scenario);
    render(`${scenarios.find((s) => s.id === scenario).name} 시나리오`);
    $('scenarios').querySelector(`[data-scenario="${scenario}"]`).focus();
  }
  if (session) {
    state = selectSession(state, session);
    render(`${state.sessions.find((s) => s.id === session).project} 선택`);
    // Only an explicit selection navigates to the narrow-screen detail view.
    // Incoming events never scroll the page or change the selected session.
    if (window.matchMedia('(max-width: 800px)').matches)
      document.querySelector('.context-panel').scrollIntoView({ block: 'start', behavior: 'instant' });
  }
  if (choice) {
    state = answer(state, target, request, choice);
    render(state.notice);
    $('preview').focus({ preventScroll: true });
  }
  if (origin) {
    state.notice = `경로 안내: ${state.sessions.find((s) => s.id === origin).agent}의 원래 세션에서 요청을 확인하세요. 이 프로토타입에는 실제 세션 연결이 없습니다.`;
    render(state.notice);
  }
  if (overview) {
    state.notice = '개요를 표시 중입니다. 선택한 세션과 키 위치는 유지됩니다.';
    render(state.notice);
  }
});
$('surface').addEventListener('change', (event) => {
  state.surface = event.target.value;
  render();
});
$('count').addEventListener('change', (event) => {
  state = replay(state, state.scenario, Number(event.target.value));
  render();
});
$('native-reply').addEventListener('change', (event) => {
  state.nativeReply = event.target.checked;
  render('직접 승인 capability 가정을 변경했습니다.');
});
$('reset').addEventListener('click', () => {
  stop();
  state = replay(createState());
  render('초기화했습니다.');
});
$('play').addEventListener('click', () => {
  if (playback) {
    stop();
    return;
  }
  $('play').textContent = 'Ⅱ 재생 중지';
  playback = setInterval(() => {
    const index = scenarios.findIndex((s) => s.id === state.scenario);
    if (index === scenarios.length - 1) {
      stop();
      return;
    }
    state = replay(state, scenarios[index + 1].id);
    render('시나리오: ' + scenarios[index + 1].name);
  }, 6000);
});
$('reference').addEventListener('click', () => $('reference-dialog').showModal());
$('close-reference').addEventListener('click', () => $('reference-dialog').close());
render();
