# 2026-03-22 — 로깅 인프라 통합 + Terminal Badge 개선

### 문제
1. `agentdeck claude` PTY 세션에서 `[agentdeck] mDNS error (ignored): EADDRNOTAVAIL` 같은 내부 에러가 사용자에게 노출. 이미 "ignored"라고 하면서 출력하는 모순.
2. Terminal badge(iTerm2) 글씨가 너무 작고, 한국어 요약이 어색.

### 해결
1. **로깅 이중 시스템 통합**: `bridge-core.ts`, `index.ts`, `voice-assistant.ts`, `wake-word.ts`에 각각 있던 로컬 `log()` (항상 stderr) → `logger.ts`의 `log()` (PTY 모드 시 억제)로 교체. mDNS "ignored" 에러 → `debug()` (디버그 파일 전용). `logError()` 신규 추가 (치명적 에러만 PTY에서도 표시).
2. **Badge 3줄 고정**: 줄 수가 폰트 크기를 결정하므로 project/summary/state 3줄로 제한. 높이 30%, 다크모드 자동 감지. LLM 요약 영어로 전환.

### 교훈 / 핵심 설계 결정
- **로깅 3단계**: `debug()` (파일 전용) < `log()` (PTY 시 억제) < `logError()` (항상 표시). daemon은 PTY 없으므로 로컬 `log()` 유지 정상
- **iTerm2 badge 폰트 = 줄 수의 함수**: 내용이 많을수록 자동 축소. 큰 글씨를 원하면 줄 수를 줄여야 함. `BADGE_MAX_HEIGHT_FRACTION` 증가만으로는 불충분
- **LLM 요약은 영어가 자연스러움**: 코드 작업 컨텍스트에서 한국어 요약("터미널 포스트잇 기능 구현 중")은 부자연스럽고 토큰 효율도 낮음

---
