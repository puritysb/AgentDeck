# 2026-02-21 — Usage Dashboard 개선 (독립 조회 · 수위 게이지 · 테두리 애니메이션)

### 문제

1. **billingType 미감지로 OAuth 조회 스킵**: billingType은 PTY 세션 배너에서만 감지 → 세션 시작 전엔 'unknown'이라 5h/7d 데이터 없음
2. **슬립/웨이크 후 stale 캐시**: 브릿지가 살아있어도 60초 캐시가 구형 resets_at 시각을 계속 보여줌
3. **세션 없을 때 사용량 미표시**: 브릿지(=claude 세션)가 없으면 플러그인이 아무것도 표시 못함
4. **구독자 Session 페이지**: 0.0K만 보이는 무의미한 페이지
5. **0.2fps 애니메이션**: 브릿지 업데이트 주기(5s)에 묶여 테두리 애니메이션이 뚝뚝 끊김

### 해결책

**브릿지 (`bridge/src/`)**
- `usage-api.ts`: OAuth 응답에서 `inferredBillingType` 추론 — 5h/7d 필드 존재 시 `subscription`, 없으면 `api`
- `state-machine.ts`: `inferBillingType()` 메서드 추가 — PTY 배너 전에도 API 응답으로 billingType 설정 가능
- `index.ts`: billingType 조건 제거(항상 OAuth fetch), `lastApiFetchTime` 추적으로 5분 초과 시 강제 재조회, 60초 주기 갱신 시 실제 broadcast 추가

**플러그인 (`plugin/src/`)**
- `plugin.ts`: 브릿지 `connected` 이벤트 시 즉시 `query_usage` 전송(슬립/웨이크 복구)
- `actions/usage-button.ts`:
  - `fetchStandaloneUsage()` — 브릿지 없이 플러그인이 직접 macOS 키체인 + Anthropic OAuth API 조회 (60초 poll)
  - 구독자 Session 페이지 제거 (`5h → 7d → extra` 만)
  - **수위 게이지 SVG**: 사용률만큼 물이 차오르는 시각적 디스플레이 + 2겹 파도
  - **독립 8fps 애니메이션 타이머**: `setInterval(125ms)` — 데이터 업데이트와 완전히 분리
  - **테두리 스핀**: `State.PROCESSING`일 때만 활성화 — Claude 처리 중에만 테두리가 빠르게 회전 + 글로우
  - 폰트: title 15→18px, sub 13→18px, opacity 강화
  - 레이아웃: 리셋까지 남은 시간을 메인 값으로, `X% · +Y.YK` (처리 중) / `X% · Z.ZK` (누적) / `X% used` (세션 없음) subtitle

### 핵심 설계 결정

- **isActive 감지**: `tokenDelta > 500` (불안정) → `currentState === State.PROCESSING` (정확)
- **독립 렌더 루프**: 8fps 타이머가 `borderFrame` / `waveFrameFine` 전진 → 데이터와 애니메이션 완전 분리
- **수위 의미**: 사용률 높을수록 물 차오름 (위험 시 꽉 참), 색상 green→yellow→red 연동

### Commits

| Hash | Message |
|------|---------|
| `db1153e` | feat: encoder takeover, option navigation, utility dial modes, usage overhaul |

---
