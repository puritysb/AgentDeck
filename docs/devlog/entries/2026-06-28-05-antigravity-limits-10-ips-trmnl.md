# 2026-06-28 — Antigravity 구독 만료일 수집 및 상단 LIMITS 정보 공간 효율 개선 (10" IPS / TRMNL)

### 문제
10" IPS 및 TRMNL 기기 등 BYOS(Bring Your Own Screen) 환경에서 화면 상단에 표시되는 구독 정보(`LIMITS`)가 가로로 너무 긴 영역을 차지하여 화면 구성의 비효율이 발생했다. 또한, Antigravity(Gemini) 세션의 경우 실시간 크레딧 정보(`1000cr`)가 불명확하게 노출되었고, 구독 만료일 정보는 수집 및 노출되지 않아 관리의 편의성이 부족했다.

### 해결
1. **Antigravity 구독 만료일 수집**:
   - `antigravityAuthStatus` DB 데이터로부터 `subscriptionActiveUntil` 등의 속성 값을 파싱하도록 구현함.
   - 만약 JSON 키로 직접 노출되지 않는 경우를 대비해, base64로 디코딩된 protobuf 아스키 데이터 목록(`strings`)에서 ISO 8601 날짜 정규식 패턴(`^\d{4}-\d{2}-\d{2}`)을 대조하여 안전하게 만료일을 식별하도록 폴백 장치를 추가함.
2. **구독 텍스트의 로고화 및 가로폭 최소화**:
   - `shared/src/trmnl-layout.ts` 헤더 영역에 `"Claude"`, `"ChatGPT Plus"`, `"Google AI Pro"` 등 불필요하게 긴 텍스트를 나열하는 대신, 각 플랜에 해당하는 모노크롬 로고 아이콘을 렌더링하고 바로 옆(간격 4px 최소화)에 플랜의 컴팩트 명칭(`Plus`, `Pro` 등)과 만료일(`→ Month Day`)만 표시하는 구조로 개선함.
   - Claude의 경우 텍스트 명칭을 생략하고 로고 아이콘과 만료일만으로 공간 효율을 극대화함.
3. **E-ink 모니터 스크린 Parity**:
   - 안드로이드 E-ink 대시보드의 Limits 행에서도 중복되던 `"AG"` 라는 라벨 접두어와 불명확한 `credits` 값 노출을 제거하고, 순수 플랜 명과 컴팩트하게 포맷팅된 만료일을 렌더링하도록 일치화함.
4. **Parity 동기화 및 테스트**:
   - `shared/src/protocol.ts`에 `AntigravityStatusInfo.subscriptionActiveUntil` 스펙을 추가하고 `pnpm generate-protocol`을 수행하여 Kotlin 및 Swift 타입 선언과 동기화함.
   - 변경된 컴팩트 렌더링 사양에 맞춰 `trmnl-layout.test.ts` 테스트 코드를 갱신하여 1566개 단위 테스트 전원 통과를 확인(Green).

---
