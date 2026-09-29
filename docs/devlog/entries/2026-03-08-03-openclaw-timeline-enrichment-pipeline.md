# 2026-03-08 — OpenClaw Timeline enrichment pipeline

### 문제
OpenClaw 타임라인이 `"Task started"` / `"Completed · Xs"` 만 표시. chat_response 0건, detail 0건, tool_exec/model_call 0건. 3가지 근본 원인:
1. Gateway `chat` delta payload에서 `payload.prompt` 조회 → 항상 null (프롬프트는 user role 메시지에 있고 delta는 assistant role만 포함)
2. 응답 텍스트가 `payload.message.content[].text` 구조인데 `payload.content`로 조회 → 미캡처
3. Plugin gateway-client가 자체 빈약한 timeline 생성 + bridge enriched timeline이 plugin에 미전달 (FORWARDED_EVENTS 누락)

### 해결
- `extractMessageText()` — Gateway `{ message: { content: [{ type: "text", text }] } }` 구조 인식
- `accumulatedResponse` — delta 스트리밍 텍스트 축적 → final에서 chat_response 생성
- `extractTopicHint()` — 프롬프트 없는 작업(cron/웹UI)에서 첫 응답 텍스트로 chat_start 업데이트
- `timeline-summarizer.ts` — MLX qwen (port 8800, `/no_think` suffix) → Ollama fallback → 한국어 1줄 요약
- ConnectionManager `FORWARDED_EVENTS`에 `timeline_event`/`timeline_history` 추가
- Plugin `receivingBridgeTimeline` flag — bridge 연결 시 gateway-client 로컬 생성 억제

### 교훈 / 핵심 설계 결정
- **Plugin과 Bridge 양쪽에 동일 enrichment 적용 필수**: Plugin이 Gateway에 직접 연결할 수 있어 bridge 경유 보장 불가
- **MLX serve URL**: `/v1/` prefix 없음 (FastAPI 기본 라우팅). 모델 이름은 `/models` endpoint로 확인
- **Qwen3.5 thinking mode**: `/no_think` suffix로 비활성화하지 않으면 thinking text가 output에 포함됨. `<think>` 태그 없이 plain text로 나올 수도 있어 multi-line 처리 필요
- **`enrichTimelineFromHistory()` 삭제**: Gateway가 `events.history` RPC 미지원 → 100% 실패하는 dead code였음
- **parseLogLine 에러 분류 순서**: error/fail 패턴을 model/memory/tool 패턴보다 **먼저** 검사해야 함. `"LLM request timed out"` → `\b(llm)\b.*\b(request)\b` 매칭 → model_call 오분류. `\bfail\b`은 `"failed"` 미매칭 → `fail(?:ed|ure)?`로 수정. 파일 경로 내 `/memory/`가 `\bmemory\b`에 매칭되어 ENOENT 에러가 memory_recall로 오분류
- **`extractReadableMessage()`**: 원본 로그의 JSON prefix, key=value 노이즈, `[subsystem]` prefix를 정리하고 ENOENT는 `파일 없음: dir/file.md`로 축약

---
