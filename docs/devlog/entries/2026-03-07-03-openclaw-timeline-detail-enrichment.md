# 2026-03-07 — OpenClaw Timeline Detail Enrichment

### 문제
OpenClaw 자율 작업 시 Android Dashboard 타임라인에 "Prompt sent" / "Response received (3m 58s)" 같은 generic 메시지만 표시됨. 실제 어떤 행위를 하는지 (어떤 페이지를 읽고, 어떤 도구를 쓰고, 무슨 응답을 받았는지) 확인 불가.

### 해결
1. **Delta prompt 캡처**: Bridge OpenClaw adapter의 `delta` 핸들러에서 `payload.prompt` 캡처 (plugin gateway-client.ts와 동일 패턴). Gateway가 자율적으로 시작한 태스크의 실제 설명이 `chat_start`에 표시됨
2. **`detail` 필드 추가**: `shared/src/timeline.ts` `TimelineEntry`에 `detail?: string` 추가. 모든 레이어(shared→bridge→plugin→android) 관통
3. **Source-rich, Client-truncate 원칙**: Source에서 raw 최대 500자, detail 최대 1000자로 넉넉히 전달. 각 클라이언트가 자체 truncation (e-ink maxLines=1, tablet 2줄+detail 별도행, SD Plugin fisheye px 기반)
4. **`lastPrompt` 리셋**: chat 종료(final/aborted/error) 시 null로 초기화 → 다음 자율 chat에 이전 prompt 잔존 방지

### 핵심 설계 결정
- **Source-rich, Client-truncate**: 네트워크 상한(raw 500, detail 1000)은 대역폭 보호용. 디스플레이 truncation은 각 기기 책임. 기존의 source-side 150/200자 절삭은 e-ink/tablet/plugin 모두에 불필요한 정보 손실
- `detail`은 optional — backward-compatible, 기존 클라이언트는 무시

---
