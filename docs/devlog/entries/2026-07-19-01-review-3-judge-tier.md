# 2026-07-19 — REVIEW 버튼: "죽은 버튼" 3중 원인 수정 + judge-tier 요청중심 평가

### 문제

데크(SD/D200H)에서 REVIEW를 눌러도 아무 반응이 없다가 한참 뒤 macOS 팝업만 떴다. 라이브 WS 프로브로 실측한 원인은 세 겹이었다: (1) **D200H `deckSignature`가 세션행의 `reviewStatus/reviewRisk`를 서명에 누락** — review만 바뀐 `sessions_list`는 "변화 없음"으로 렌더 스킵되어 REVIEWING 플립과 verdict 배지가 기기에 아예 그려지지 않았다. (2) macOS 패널이 결과가 나와야만 떠서 judge 실행(실측 25~100초) 동안 무피드백. (3) FM 추론 중 데몬 정체 시 `running` 브로드캐스트가 49초까지 지연 — 데몬 왕복에 의존한 ack는 이 경우 무력. 부가로 judge 호출에 타임아웃이 없고 running-guard에 TTL이 없어 행 걸린 judge가 버튼을 영구 봉인할 수 있었다.

또한 판정 자체의 품질 문제: FM(온디바이스 소형 모델)에 전체 risk rubric을 주면 docs 세션에 "Missing Secrets" 같은 환각 finding, `optional/path` 플레이스홀더 에코, "medium risk + findings 0" 비일관 출력이 실측됐다. 관측 세션 타임라인은 tool_exec가 억제되어 TOOL 행이 없으므로 "검증 생략" 판정은 구조적으로 불가능한데 rubric은 그것을 요구하고 있었다.

### 해결

`e03e7bc0`: ① 양 플러그인에 press 즉시 optimistic REVIEWING 플립(20s TTL, 데몬 row 우선, `review_status: error`가 해제 신호) + D200H 서명에 review 필드 추가. ② Swift 데몬 `ReviewPanelPresenter.presentRunning` — 수락 즉시 스피너+elapsed 진행 패널, 모든 종료 경로(거절/빈 타임라인/judge 실패/타임아웃)가 같은 패널을 in-place 갱신. ③ judge 호출 180s 하드 타임아웃 + running 배지 5분 stale-TTL. ④ openclaw 가상 row에 review 배지 부착(sessionToDict 우회 경로).

`f5ffdf13`: 평가 목적을 "사용자가 요청한 것을 적절히 처리했나"(요청↔응답 정렬)로 재정의하고, 설정된 backend에서 **judge tier를 자동 도출** — FM/Swift-openclaw=basic(좁은 정렬 체크만, 6k자/60행), openai·mlx·api·Node-openclaw=advanced(전체 rubric, 24k자/200행·60KB diff). Node 리뷰는 diff에 최근 USER/AGENT 타임라인 컨텍스트를 함께 투입. 동일 trajectory A/B: 구 프롬프트 "medium+지어낸 security 우려" → 신 basic "low/0, 요청중심 요약".

### 핵심 설계 결정

- **press ack는 로컬이 정답.** 데몬 왕복은 평시 ~50ms지만 judge 추론 중 수십 초 정체가 실측됐다 — 즉각 피드백은 기기 로컬 optimistic 상태로 보장하고, 데몬 브로드캐스트는 그것을 "확정/해제"하는 신호로 쓴다.
- **프롬프트는 judge 용량에 맞춘다.** 소형 모델에 광범위 rubric을 주면 빈칸을 환각으로 채운다 — basic tier는 "각 답변이 요청을 다뤘나" 하나만 묻고, 판정 불가능한 항목(TOOL 행 부재 시 검증 여부)은 아예 요구하지 않는다. tier는 새 설정 없이 backend에서 도출.
- **비일관 verdict는 파서가 강등.** findings 0개인 medium/high는 judge 노이즈로 간주해 low로 clamp (Swift/Node 미러).
