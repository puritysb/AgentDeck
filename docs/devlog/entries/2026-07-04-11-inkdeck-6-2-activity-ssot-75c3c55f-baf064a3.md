# 2026-07-04 — InkDeck 라운드 6: 2줄 위치 교정 + activity SSOT 표면 정렬 (커밋 75c3c55f, baf064a3)

- 라운드 5 오독 교정: **2줄은 카드의 에이전트 활동 요약**(카드의 핵심), 하단 타임라인 티커는 1줄 유지. 좁은 카드에서 사라졌던 모델 표시 복원(classic 폰트 강하로 전 카드 유지).
- **activity 원라이너 표면 감사**: 브리지가 sessions_list에 붙이는 공유 `activity`(session-activity.ts, "Shared by X3+TRMNL" 주석)를 실제로 읽는 표면이 InkDeck뿐이었음 — Android는 `SessionInfo`에 필드 미선언(`ignoreUnknownKeys`가 조용히 폐기), Apple은 미디코드. 각자 `프로젝트·모델`/`모델·상태` 서브라인을 손으로 만들어 표면마다 다르게 보였던 원인.
- 수정: Android `Protocol.kt SessionInfo.activity` + `EinkAgentBlock` 3행 + 태블릿 `SessionListPanel`; Apple `Protocol.swift` 디코드 + `SessionListPanel.swift` 행. primary 행은 anchor sibling에서 차용(state_update엔 activity 없음). Android JUnit 195 pass, macOS BUILD SUCCEEDED.
- **잔여 갭**: Swift in-process 데몬은 자체 sessions_list를 만들며 activity를 계산하지 않음 — Swift에 activityFor 포트 필요(추후).
