# 2026-07-04 — InkDeck 라운드 4: 폰트 캐스케이드 + 구독 표시 + Antigravity + 타임라인 티커 (커밋 205ca86f)

- **말줄임 최소화**: 텍스트가 넘치면 자르기 전에 폰트를 한 단계 낮춤(`fitCascade`: 이름 Bold12→Bold9, 상태/활동 9pt→classic 6×8). 3열 카드는 글리프 48px로 축소해 텍스트 폭 확보, model 태그는 넓은 카드에만.
- **구독 만료**: usage_update `subscriptions[{name,until}]`를 serial로 전달(ISO until→"~M/D" 프리포맷), LIMITS 행 라벨 아래 classic 서브라인("Max 20x ~7/12") — 데몬이 resolve 못 하면 자연스럽게 숨김. 펌웨어 `g_state.subscriptions[3]` 신규 파싱.
- **Antigravity**: 계정 연동 시에만 텍스트 행(글리프+"13450 credits · Pro"). 크레딧은 raw count라 바 없음.
- **타임라인 티커**: 최신 timeline 이벤트 1줄("16:52 요약")을 최하단에 — e-ink용 초압축 타임라인. **contentHash에서 제외 + 60초당 1회만 자체 리프레시**(tool 이벤트 폭주가 패널을 스트로브하지 않게; 다른 갱신에는 피기백). serial 경로가 host-local "HH:MM"(`localHm`)을 스탬프(패널은 tz 없음, 기존 ts는 UTC유래).
- 푸터 재배치: rule 370, 프로바이더 행 28px×3 + 티커 라인; 카드 영역 78..366(독 시 330..366).
