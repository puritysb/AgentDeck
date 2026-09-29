# 2026-03-06 — Claude Code Version Check & AgentDeck Self-Update

### 문제
AgentDeck은 Claude Code 터미널 출력을 regex로 파싱하므로, Claude Code 업데이트로 출력 형식이 바뀌면 파싱이 깨진다. 기존에는 `claude --version` 존재만 확인하고 버전 호환성은 검증하지 않았다.

### 해결
`sdc` 시작 시 버전 호환성 자동 체크 시스템 구현:
- `bridge/src/version-check.ts` — 핵심 모듈. `checkVersionCompatibility()` 오케스트레이터
- `check-deps.ts`에서 `claude --version` 출력 캡처하여 버전 전달
- `bridge/package.json`에 `compatibleClaudeCode` semver range 필드 추가
- npm registry 조회 (3s timeout) → GitHub raw `compatibility.json` fallback (3s)
- 비호환 감지 시 `npm install -g @agentdeck/bridge@latest` 자동 실행
- `~/.agentdeck/compatibility.json`으로 상태 캐시 (1시간 throttle)
- `setup/src/setup.ts`에 초기 상태 시딩 추가

### 핵심 설계 결정
- **Startup 절대 차단 안 함**: 모든 실패 케이스(오프라인, 파싱 실패, 설치 권한 오류)는 경고 후 진행
- **`satisfiesRange()` 자체 구현**: `semver` 패키지 의존 없이 `>=X.Y.Z <A.B.C` 형식 지원
- **2-tier fallback**: npm view → GitHub raw JSON. npm publish 없이도 `compatibility.json` 업데이트로 호환성 정보 갱신 가능
- **`--no-update-check` 플래그**: CI/스크립트 환경용 비활성화 옵션

---
