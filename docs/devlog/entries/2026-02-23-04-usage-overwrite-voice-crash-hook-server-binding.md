# 2026-02-23 — Usage Overwrite, Voice Crash, Hook Server Binding 수정

### 문제
피드백으로 보고된 3가지 이슈:
1. **Usage 덮어쓰기**: `setOutputTokens`가 PTY 상태줄 값을 직접 대입해 hook으로 누적된 세션 토큰 수를 덮어씀
2. **Voice error → 브릿지 크래시**: `VoiceManager.emit('error')`에 리스너 미등록 → Node.js EventEmitter가 uncaught exception throw → 프로세스 종료. 보고는 "UI 고정"이었으나 실제로는 크래시
3. **Hook server 0.0.0.0 바인딩**: `server.listen(port)` 기본값이 모든 인터페이스에 노출

### 해결
1. `usage-tracker.ts`: `this.outputTokens = tokens` → `Math.max(this.outputTokens, tokens)` — PTY 누적치면 동일, 턴별 값이면 regression 방지
2. `index.ts`: `voiceManager.on('error', ...)` 리스너 추가 — 에러 로깅 + `voice_state: error` broadcast
3. `hook-server.ts`: `server.listen(port, '127.0.0.1', ...)` — `session-registry.ts`와 동일 패턴

### 교훈
- **Node.js EventEmitter 'error' 이벤트**: 리스너 없으면 자동으로 uncaught exception throw → 프로세스 크래시. `emit('error')`를 사용하는 모든 EventEmitter에 반드시 error 리스너 등록 필요

---
