# 2026-03-20 — Timeline 품질 개선: LLM 요약 확장 + detail 클리닝 + 필터 정밀화

### 문제
1. Claude Code chat_end에 LLM 요약이 없어 "Completed · 15s · Read, Edit"로만 표시 (OpenClaw만 LLM 요약 적용)
2. detail 필드에 `**bold**`, `## heading`, code fence 등 마크다운 artifact 그대로 노출
3. `parseLogLine()`의 broad 키워드 필터(`/whatsapp/i`, `/WebSocket error/i`)가 사용자 작업 로그까지 삼킴 — 에이전트가 "WhatsApp API 연동" 작업 시 tool/error 로그 소실

### 해결
- **Claude Code LLM 요약**: `bridge/src/index.ts` Stop hook에 `summarizeResponse()` + `upsertEntry()` async enrichment 추가 (OpenClaw 패턴 동일)
- **`cleanDetailText()`**: `shared/src/timeline.ts`에 추가. markdown 제거(bold/heading/fence/link/list/blockquote/inline code), JSON blob 감지(시스템 JSON 필터, error 필드 추출), blank line 축소. Bridge/plugin 3곳에서 detail 저장 전 적용
- **`extractTopicHint()` 개선**: code fence 내부 스킵(`inCodeFence` toggle), markdown decorator 제거 후 평가, 한국어 접두사 chained 제거("네, 확인했습니다." → 핵심만)
- **필터 정밀화**: broad 키워드 → `isChannelInfra` subsystem/module 기반 플래그로 전환. `model_fallback_decision` JSON, `Delivery exceeded max retries` 추가 필터

### 교훈 / 핵심 설계 결정
- **로그 필터는 메시지 내용이 아닌 출처(subsystem/module)로 판단해야** false-positive 방지 가능. OpenClaw 로그는 구조화된 `subsystem`/`module` 필드를 제공하므로 이를 우선 사용
- **Source-rich, Client-truncate 원칙**은 detail 클리닝에도 적용: 원본은 넉넉히 전달하되, 클라이언트가 표시 전에 `cleanDetailText()` 거치도록

---
