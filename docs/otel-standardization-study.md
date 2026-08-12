# OTel ↔ APME 표준화 검토 보고서

> 결정용 study 문서. 구현 plan 아님. 옵션 채택 시 별도 plan 으로 진행.
>
> **작성일**: 2026-04-25
> **트리거**: Codex CLI 의 OTel 수신기 도입(`/otel/v1/traces`) 직후, APME 자체 포맷 ingestion 의 표준화 필요성 재검토.

---

## TL;DR

- **APME 의 evaluation 데이터(judge axes / vibe / composite_score) 는 OTel 로 표준화하지 말 것.** 산업 표준 부재 + 의미 손실.
- **APME 의 lifecycle/ingestion (turn 경계, tool call, session 메타) 은 표준화 가치 있음.** 다만 진짜 OTLP 와이어가 아니라 **bridge 내부 OTel-shape envelope** 으로만 정렬. Codex 가 이미 진짜 OTLP, 나머지는 동일한 *모양* 을 내부적으로 재사용.
- **OpenTelemetry GenAI semconv 는 아직 "Development"** 등급 — stable 아님. 따라서 internal envelope 를 GenAI semconv 에 **준거**(reference)는 하되 **고정**(pin)하지는 않는 정책 권고.
- **즉시 권고**: `AgentDeck eval v1` JSON Schema 추출 + 버전 헤더(작업 1~2일).
- **단기 권고**: bridge 내부 ingestion path 일원화(작업 3~5일).
- **거절**: APME 결과를 OTLP 로 외부 export, 모든 에이전트에 진짜 OTLP receiver 노출.

---

## 1. 배경

### 1.1 Codex OTel 수신기 (이미 ship)

[apple/AgentDeck/Daemon/Modules/CodexOtelRoutes.swift:24-45](../apple/AgentDeck/Daemon/Modules/CodexOtelRoutes.swift) 가 daemon 내장 HTTP 서버에 `/otel/v1/traces` 라우트를 등록. JSON-only(`application/json` 아니면 415 반환) — `HTTPServer` 가 body 를 UTF-8 로 stringify 하기 때문. [CodexConfigInstaller.swift](../apple/AgentDeck/Daemon/Core/CodexConfigInstaller.swift) 가 security-scoped bookmark 로 `~/.codex/config.toml` 에 `[otel.trace_exporter.otlp-http]` + `protocol = "json"` 을 fence 안에 주입한다.

[CodexTelemetryModule.swift:31-85](../apple/AgentDeck/Daemon/Modules/CodexTelemetryModule.swift) 는 OTLP `ExportTraceServiceRequest` JSON 을 4가지 distilled event 로 환원:

```swift
enum CodexSpanEvent: Sendable, Equatable {
    case turnStart(threadId, turnId, cwd?)
    case toolCall(threadId, turnId, tool)
    case toolResult(threadId, turnId)
    case turnEnd(threadId, turnId)
}
```

attribute 키는 `codex.thread_id` / `thread.id` / `thread_id` 식 변형을 모두 수용(파일 주석: *"Codex's OTel keys are not formally documented as a stable API"*). 즉 **Codex 자체도 GenAI semconv 가 아닌 자기 namespace** 를 쓴다.

### 1.2 APME ingestion (2026-08-12 현재)

| 경로 | 코드 위치 | 입력 형태 |
|---|---|---|
| **Claude Code** | [`bridge/src/index.ts`](../bridge/src/index.ts) + `claude-hook.ts` | lifecycle hook spans; Stop의 `transcript_path` JSONL에서 응답 본문 읽기 |
| **OpenClaw / OpenCode** | [`bridge/src/index.ts`](../bridge/src/index.ts) `wireAgentApme()` | native Gateway/SSE timeline events |
| **Codex** | `codex-hook.ts` + `codex-turn-manager.ts` | lifecycle/notify spans; rollout JSONL에서 응답 본문 읽기 |

수렴 지점은 [`bridge/src/apme/collector.ts`](../bridge/src/apme/collector.ts):

- `ingestHook(sid, event, data)` — collector.ts:115
- `getActiveTurnId(sid)` — collector.ts:222
- `setTurnResponse(sid, response)` — collector.ts:327
- `splitRun(sid, projectPath?)` — collector.ts:403
- `updateModel(sid, modelId)` — collector.ts:425

저장은 [`bridge/src/apme/store.ts`](../bridge/src/apme/store.ts) 의 SQLite 7-table:

- `runs` (store.ts:34) — session 메타 + `task_category` + `outcome` + `composite_score`
- `steps` (store.ts:60) — hook event 원본 로그
- `turns` (store.ts:69) — Q&A pair
- `tasks` (store.ts:92) — 경계로 묶인 turn group
- `evals` (store.ts:119) — judge layer 별 axis score + raw JSON
- `rubrics` (store.ts:133), `vibe_feedback` (store.ts:143)

평가 결과는 [`runner.ts`](../bridge/src/apme/runner.ts) 의 `parseJudgeJson()` 가 카테고리 별로 7개 rubric (general/conversation/planning/research/debugging/refactoring/review/correctness) 를 dispatch 하고, 각 rubric 은 자체 axes(예: `task_completion`/`code_quality`/`efficiency`/`overall`) 를 가진다.

외부 노출 표면: [`bridge/src/apme/http.ts:39-180`](../bridge/src/apme/http.ts) — `GET /apme/runs`, `GET /apme/run/:id`, `GET /apme/scorecard`, `GET /apme/categories`, `GET /apme/rubric/current`, `POST /apme/vibe`, `POST /apme/recommend`, `POST /apme/tune`. **OTLP exporter / Prometheus exporter 없음.**

---

## 2. 두 레이어를 섞으면 안 되는 이유

### 2.1 L1 — Lifecycle / Wire (표준화 적합)

- 데이터 성격: turn 시작·종료, tool call·result, model 식별, session 메타, cwd
- 산업 표준 존재: **OpenTelemetry GenAI semconv** (`gen_ai.system`, `gen_ai.request.model`, `gen_ai.operation.name`, `gen_ai.tool.name`, span event `gen_ai.user.message` 등)
- **단, 안정도 주의**: OpenTelemetry 공식 GenAI 문서는 현재 *Development* 상태로 표시되어 있음 (https://opentelemetry.io/docs/specs/semconv/gen-ai/). attribute 명·이벤트 구조가 변할 수 있음.
- AgentDeck 매핑:
  - `run_id` ↔ `trace_id`
  - `turn_index` ↔ span 계층(parent span = turn, child span = tool call)
  - `steps` row ↔ span event
  - `model_id`, `agent_type` ↔ resource attributes

**판단**: L1 은 표준화 적합. 단 GenAI semconv 가 Development 인 동안은 외부 와이어로 pin 하지 말고, 우리 internal type 이 **준거**(referenceable) 하되 **소유**(owned) 한 상태를 유지.

### 2.2 L2 — Evaluation (표준화 부적합)

- 데이터 성격:
  - rubric 별 axes (예: `task_completion: 0.85`, `code_quality: 0.8`)
  - `composite_score` 가중합 (outcome 0.4 + judge 0.4 + efficiency 0.15 + vibe 0.05)
  - `vibe_feedback` (사용자 in-the-loop 라벨)
  - `reasoning` (수십~수백 줄 자연어 텍스트)
  - `done` / `missed` 항목 리스트
  - rubric tuner 출력
- 산업 표준 **없음**. agent-eval 영역은 LangSmith, Braintrust, Phoenix 등 각 vendor 자체 schema. OTel Logs Data Model 은 reasoning 텍스트를 "그릇"으로는 담을 수 있지만 axes/composite weighting 을 1급 시민으로 다루지 못함.
- 의미 손실 위험:
  - axes 를 `span.attributes.eval.task_completion=0.85` 식으로 펴 넣으면 cardinality 증가 + 쿼리 가독성 ↓
  - vibe 는 OTel 의 어떤 1급 개념과도 매핑 안 됨
  - composite weighting 은 application logic — telemetry 가 아니라 데이터 모델

**판단**: L2 는 자체 schema 유지. 단 외부 소비자를 위해 **버전화된 JSON Schema** 로 명세화.

---

## 3. 옵션 매트릭스

| 옵션 | 범위 | 작업량 | 이득 | 리스크 |
|---|---|---|---|---|
| **A. Inbound wire 통일** (좁은 버전) | bridge 내부에서 hook/timeline/PTY 결과를 OTel-shape internal struct 로 normalize. APME collector 는 단일 path 소비. **외부 와이어 변경 없음** | 中-大 (3~5일) | ingestion 일관성, 새 agent 추가 시 어댑터 1개로 끝, 코드 가독성 ↑ | collector 5개 메서드 + 어댑터 4곳 재작성, 회귀 위험, hook unreliability 자체는 해결 못함 |
| **A'. Inbound wire 통일 (full)** | 모든 에이전트에 진짜 OTLP receiver 노출 | 大 (1~2주) | 산업 표준 호환 | Codex 외 에이전트는 OTel emitter 없음 → ROI 무, App Review 4.2.3 risk |
| **B. Outbound OTLP export** | APME 결과를 OTLP logs/metrics 로 외부 collector(Grafana/Datadog 등) 에 push | 中 (2~3일) | 제3자 옵저버빌리티, 대시보드 reuse | App Review 5.1.1 privacy 공시, 옵트인 UI, default OFF 필수, 사용 신호 부재 |
| **C. Schema 명세화** | `AgentDeck eval v1` JSON Schema + 버전 헤더 + `docs/apme.md` 에 breaking-change rule | 小 (1~2일) | 외부 소비자 안정 계약, 미래 옵션 A 선결조건이기도 함 | 구조 개선 없음 (단독으론 부채 미해결) |
| **D. 현상 유지** | — | 0 | — | 다음 에이전트 추가 시 또 ad-hoc 어댑터, 부채 누적 |

---

## 4. Apple App Review 영향 분석

각 가이드라인 번호별 명시 답변:

### 4.1 가이드라인 2.5.2 (self-contained, 인터프리터/외부 바이너리 금지)

- 옵션 A/A'/C: **무위험**. 모두 daemon 내부에서 처리. Codex receiver 는 이미 ship + `verify-appstore-archive.sh` 통과 ([apple/scripts/verify-appstore-archive.sh](../apple/scripts/verify-appstore-archive.sh)).
- 옵션 B: 사용자에게 외부 OTel Collector / Prometheus / Grafana 를 띄우라고 안내하면 위반. **endpoint URL 입력 필드만 노출 + 설정 책임은 사용자 본인** 이라는 자세를 유지하면 OK.
- memory 참조: `appstore-invariants.md` — *"do not reintroduce subprocess paths under any guard"*.

### 4.2 가이드라인 4.2.3 (companion-install prompt 금지)

- 옵션 A: 안전. bridge 측 변환은 **Node CLI(외부 daemon)** 안에서만. 하지만 [apple/AgentDeck/UI/Monitor/SetupNeededCard.swift](../apple/AgentDeck/UI/Monitor/SetupNeededCard.swift) 의 정적 카피 규칙은 그대로 적용 — "Install AgentDeck CLI to get OTel ingestion" 같은 추가 카피 금지. 옵션 A 가 활성화되든 아니든 사용자에게 보이는 카피는 바뀌지 않아야 한다.
- 옵션 A': 새 에이전트(Claude/OpenCode) 에 OTel SDK 를 사용자가 설치하라고 안내해야 하면 위반. **bridge 가 자동 fence-write 하는 경로**(Codex 처럼)만 OK. 단 Claude/OpenCode 는 자체 OTel SDK 부재이므로 자동 주입 자체가 불가 → 옵션 A' 의 ROI 가 0.
- 옵션 B: 외부 서비스 안내 문구는 위반 가능. *"Set your OTLP endpoint URL"* 정도는 단순 설정 문구이므로 안전.

### 4.3 가이드라인 5.1.1 (privacy)

- 옵션 A/C: prompt/response 가 외부로 나가지 않음. **무영향**.
- 옵션 B: prompt/response/judge reasoning 텍스트가 사용자 외부 서버로 송신될 수 있음. 필요한 것:
  - 명시 옵트인 토글
  - default OFF
  - Privacy Policy 갱신 + App Store Connect Privacy Nutrition Label 갱신
  - endpoint, 헤더(API key) 가 settings UI 에서 명확히 보여야 함
  - "이 데이터가 외부로 나간다" 는 인라인 디스클로저
- App Store 에선 **B 옵션 자체가 compile-out** 되도록 `#if !AGENTDECK_APP_STORE` 가드를 두는 것이 가장 안전.

### 4.4 entitlements

- `com.apple.security.network.server` (Codex receiver 가 이미 사용). 옵션 A 에선 Node bridge 가 하는 일이라 Apple 영향 없음.
- App Store 빌드에서 outbound TLS(`com.apple.security.network.client`) 는 이미 활성. 옵션 B 도 추가 entitlement 불필요.

### 4.5 결론

- **옵션 A (좁은 버전)**: App Review 영향 0.
- **옵션 A' (full)**: ROI 무 + 4.2.3 risk → **거절**.
- **옵션 B**: 5.1.1 부담 + 사용 신호 없음 → **거절** (수요 발생 시 재검토).
- **옵션 C**: 영향 0.

---

## 5. 사용성 영향

### 5.1 옵션 A (inbound 통일, 좁은 버전)

- **사용자 체감 변화**: 0. 모든 변환은 bridge 내부.
- **Hook 누락 대응**: Codex는 별도 `notify` completion과 다음 prompt 경계를 사용한다. Claude는 Stop payload의 `transcript_path`를 응답 정본으로 사용한다. 터미널 화면 파싱은 APME 복구 경로가 아니다.
- **신규 에이전트 추가 비용**: 어댑터 1개로 끝 (현재는 ingestion 3분기 + collector 다중 entrypoint).
- **디버깅**: telemetry envelope 통일 → log 출력이 일관됨. 현재 `debug('APME', …)` 로그를 OTel-shape envelope 로 바꿀 수 있음.

### 5.2 옵션 B (outbound export)

- 새 settings UI 필요. `IntegrationsView.swift` 의 두 그룹(memory: `integrations-two-groups.md`) 중 **API-key 그룹** 에 OTLP endpoint + 헤더 입력 필드 추가가 자연. 단 App Store 빌드에선 compile-out.
- 토글 OFF 가 default. 사용자가 명시 enable + endpoint 입력해야 동작.
- 외부 collector 가 죽었을 때 retry/back-off 로직 + circuit breaker 가 필요 (memory: `bug_pixoo_urlsession_starvation.md` 패턴 재사용 가능).

### 5.3 옵션 C (schema 명세화)

- 사용자 영향 0. 외부 도구 작성자에게만 의미.
- 보너스: 향후 옵션 A 의 internal envelope 정의에도 그대로 재사용 가능.

---

## 6. 기술적 현실 점검

### 6.1 OpenTelemetry GenAI semconv 안정도

- 공식 문서 (https://opentelemetry.io/docs/specs/semconv/gen-ai/): **Development** 단계.
- 함의: gen_ai.* attribute 명·이벤트 구조가 minor 단위로 변할 수 있음. 외부 와이어로 pin 하면 churn 흡수 비용 발생.
- **권고**: AgentDeck internal envelope 의 attribute 키는 GenAI semconv 의 **현 시점 명명 규약을 모방** 하되 (예: `gen_ai.request.model`, `gen_ai.tool.name`), 우리 namespace (`agentdeck.*` 또는 `apme.*`) 로 fork 해 둔다. semconv 가 stable 되면 그때 alias / 마이그레이션.

### 6.2 OTel Logs Data Model 이 judge reasoning 에 적합한가

- LogRecord 의 `body` 가 unstructured/semi-structured 텍스트를 받으므로 *기술적으로* 가능.
- 그러나 reasoning 텍스트가 수십~수백 줄 + `done`/`missed` 리스트 + axes 점수 dict 를 한 객체로 묶어야 하는데, OTel LogRecord 의 attribute 평면 구조와 어울리지 않음.
- **결론**: 불가능하지 않으나 부자연스러움. evaluation 결과는 자체 JSON 으로 유지가 옳다.

### 6.3 비-Codex 에이전트의 OTLP emission 현실

| Agent | 자체 OTel SDK | bridge 측 변환 가능? | 결론 |
|---|---|---|---|
| Claude Code | 없음 (hook + transcript) | 가능 (hook payload → internal envelope) | bridge 내부 변환만 |
| OpenCode | 자체 SSE 이벤트 (확인 필요) | 가능 (timeline → internal envelope) | bridge 내부 변환만 |
| OpenClaw | gateway timeline | 가능 | bridge 내부 변환만 |
| Codex | OTLP/HTTP JSON ✓ | 이미 진짜 OTLP path | 그대로 유지 |

옵션 A' (모든 agent 에 진짜 OTLP receiver 노출) 가 ROI 가 없는 이유: Codex 외엔 진짜 OTLP emitter 가 없으므로, 어차피 bridge 내부에서 합성해야 한다. 그렇다면 internal struct 로 충분.

### 6.4 단일소스 패턴 재사용 가능성

[shared/src/protocol.ts](../shared/src/protocol.ts) + [shared/src/gateway-protocol.ts](../shared/src/gateway-protocol.ts) 가 `pnpm generate-protocol` 로 Swift/Kotlin 타입을 자동 생성하는 패턴(memory: `gateway-protocol-single-source.md`) 을 그대로 차용 가능:

- `shared/src/eval-schema.ts` — APME v1 JSON Schema (옵션 C 산출물)
- `shared/src/telemetry-envelope.ts` — internal OTel-shape envelope (옵션 A 산출물)
- `pnpm generate-protocol` → Swift `ApmeEvalV1.swift` + Kotlin `ApmeEvalV1.kt`

이러면 Swift daemon 의 APME 사용처(`AgentDeckTests`, `apple/AgentDeck/State/`) 에서도 동일 schema 를 import.

---

## 7. 권고

### 7.1 즉시 (옵션 C, 작업 1~2일)

**`AgentDeck eval v1` JSON Schema 추출 + 버전 헤더.**

구체 단계:
1. [bridge/src/apme/store.ts:34-150](../bridge/src/apme/store.ts) 의 7개 테이블 + [runner.ts](../bridge/src/apme/runner.ts) 의 `ParsedJudge` 타입을 source-of-truth 로 삼아 `shared/src/eval-schema.ts` (또는 `eval-schema.json`) 작성.
2. HTTP API 응답에 `"schema": "agentdeck-eval/v1"` 헤더 필드 추가 ([bridge/src/apme/http.ts:46-180](../bridge/src/apme/http.ts) 의 모든 GET 응답).
3. `docs/apme.md` 끝에 `## Schema versioning` 섹션 추가:
   - v1 의 의미 (필드 + axes 정의)
   - breaking change 정책 (필드 제거 / 의미 변경 시 v2 발행)
   - additive 변경(새 axis, 새 카테고리)은 v1 유지
4. `pnpm generate-protocol` 파이프라인에 schema 추가, Swift/Kotlin 타입 자동 생성.

**왜 즉시?** 비용이 낮고, 옵션 A 의 선결 조건. 외부 도구 작성자(향후 사용자, 자체 dashboard 등) 에게 안정 계약 제공. App Store 영향 0.

### 7.2 단기 (옵션 A 좁은 버전, 작업 3~5일)

**bridge 내부 ingestion path 일원화.**

구체 단계:
1. `shared/src/telemetry-envelope.ts` 신설:
   ```ts
   type TelemetrySpan = {
     traceId: string;     // ≈ run_id
     spanId: string;      // ≈ turn_id 또는 step_id
     parentSpanId?: string;
     name: string;        // 예: "agentdeck.turn", "agentdeck.tool.call"
     kind: 'turn_start' | 'turn_end' | 'tool_call' | 'tool_result' | 'user_prompt';
     attributes: {
       agent_type?: string;
       'gen_ai.request.model'?: string;
       'gen_ai.tool.name'?: string;
       cwd?: string;
       // …
     };
     ts: number;
   };
   ```
   GenAI semconv 명명 모방 + agentdeck namespace 의 hybrid.
2. 각 ingestion 어댑터를 `TelemetrySpan` emitter 로 재작성:
   - `claudeHookAdapter(hookPayload) → TelemetrySpan[]`
   - `claudePtyAdapter(ringbuffer, ⏺-marker) → TelemetrySpan[]`
   - `timelineAdapter(timelineEvent) → TelemetrySpan[]`
   - `codexOtlpAdapter(otlpJson) → TelemetrySpan[]` (있으면)
3. [`bridge/src/apme/collector.ts`](../bridge/src/apme/collector.ts) 의 ingest 함수를 `ingestSpan(sid, span: TelemetrySpan)` 단일 entrypoint 로 통합. 기존 `ingestHook`, `setTurnResponse`, `splitRun` 등은 내부 구현으로 강등.
4. [`bridge/src/index.ts:481-563`](../bridge/src/index.ts), [`:1269-1356`](../bridge/src/index.ts) 의 ad-hoc 분기를 어댑터 호출로 교체.
5. 기존 `steps.payload` (raw JSON) 는 `attributes` 로 매핑. backward compat 필요시 v1 schema 안에 `payload` 필드 유지.

**핵심 비-목표(non-goals)**: 외부 와이어 변경 없음. 진짜 OTLP receiver 추가 없음. hook unreliability 해결 약속 없음(별개 문제). gen_ai.* semconv 100% 준수 약속 없음 — 안정될 때까지 우리 namespace 유지.

**검증**: 기존 `bridge/test/` 의 APME 테스트 + 새 `telemetry-envelope.test.ts` 단위 테스트.

### 7.3 거절

- **옵션 A' (full OTLP)**: Codex 외 에이전트엔 OTel emitter 없음 + 4.2.3 risk + ROI 0.
- **옵션 B (outbound OTLP)**: 사용 신호 부재 + 5.1.1 privacy 부담. 사용자 명시 요청 시 재검토.

### 7.4 거절하지만 메모해 둘 것

옵션 A 가 끝나면 옵션 B 를 적은 비용으로 얹을 수 있는 구조가 됨 (`TelemetrySpan` → OTLP exporter 어댑터 1개). 사용자 요청 발생 시 옵션 A 의 envelope 위에 export 모듈만 추가.

---

## 8. 미해결 질문

1. **OpenCode 가 자체 OTLP/SSE/이벤트 emitter 를 가지고 있는가?** 있다면 옵션 A 의 OpenCode 어댑터를 단순화 가능. (조사 필요)
2. **Codex CLI 의 OTLP 가 향후 GenAI semconv 로 정렬할 계획?** 정렬되면 우리 namespace fork 의 의미가 줄어듦. (Codex 1.x 릴리즈 노트 트래킹 필요)
3. **Swift daemon 측의 APME 사용처는?** 현재 보고서는 Node bridge 의 APME 가 source-of-truth 라고 가정. macOS App Store 빌드의 in-process daemon 도 자체 APME 를 가질지, Node bridge 와 동기화할지 결정 필요.
4. **`AGENTDECK_APP_STORE` 가드와의 상호작용**: 옵션 A 의 envelope 는 Node bridge 안에서만 사니까 가드 무관. 단 옵션 C 의 schema 가 Swift 에 import 된다면 `#if AGENTDECK_APP_STORE` 환경에서 build 되어야 — 이건 schema 가 pure data type 이므로 자동 충족.

---

## 9. 다음 step (옵션 채택 시)

이 보고서 승인 후:

- **옵션 C 채택** → 별도 plan: `plans/eval-schema-v1.md`. 산출물: `shared/src/eval-schema.{ts,json}`, `docs/apme.md` 갱신, HTTP API 헤더.
- **옵션 A 채택** → 별도 plan: `plans/telemetry-envelope-internal.md`. 산출물: `shared/src/telemetry-envelope.ts`, 어댑터 4개, collector 단일 entrypoint, 테스트.
- **둘 다 채택** → C 먼저, A 가 C 의 schema 위에서 빌드.

---

## 부록 A — 핵심 파일 인용 (검증 완료)

| 파일 | 라인 | 내용 |
|---|---|---|
| `apple/AgentDeck/Daemon/Modules/CodexOtelRoutes.swift` | 24-45 | OTLP/HTTP JSON 라우트 등록, 415 응답 |
| `apple/AgentDeck/Daemon/Modules/CodexTelemetryModule.swift` | 18-23 | `CodexSpanEvent` enum (4 case) |
| `apple/AgentDeck/Daemon/Modules/CodexTelemetryModule.swift` | 31-50 | `parse()` entry |
| `apple/AgentDeck/Daemon/Modules/CodexTelemetryModule.swift` | 54-85 | span name normalization + classification |
| `apple/AgentDeck/Daemon/Modules/CodexTelemetryModule.swift` | 101-122 | OTLP attribute flattening |
| `apple/AgentDeck/Daemon/Core/CodexConfigInstaller.swift` | (전체 308줄) | security-scoped bookmark + fence 주입 |
| `apple/AgentDeck/Daemon/Core/MiniToml.swift` | (전체 162줄) | fence 보존형 TOML 편집기 |
| `bridge/src/index.ts` | 226-238 | APME 초기화 + judge result → timeline |
| `bridge/src/index.ts` | 464-466 | `wireAgentApme()` 호출 (non-Claude) |
| `bridge/src/index.ts` | hook event branch | Claude/Codex hook → telemetry span |
| `bridge/src/index.ts` | `terminal_ui` branch | managed UI affordance만 state projection; APME 미사용 |
| `bridge/src/apme/claude-transcript-reader.ts` | `readLastTurn()` | Claude transcript response extraction |
| `bridge/src/codex-rollout-response.ts` | `codexTurnOutcomeFromRollout()` | Codex rollout response/error extraction |
| `bridge/src/index.ts` | 1226-1259 | `classifyAndEnqueueTurn()` shared helper |
| `bridge/src/index.ts` | 1269-1356 | `wireAgentApme()` 본체 (chat_start/response/tool_request/tool_resolved 분기) |
| `bridge/src/apme/collector.ts` | 115-194 | `ingestHook()` |
| `bridge/src/apme/collector.ts` | 222-286 | `getActiveTurnId()` 외 |
| `bridge/src/apme/collector.ts` | 327-347 | `setTurnResponse()` |
| `bridge/src/apme/collector.ts` | 387-441 | `updateUsage / splitRun / updateModel` |
| `bridge/src/apme/store.ts` | 34-150 | 7-table CREATE TABLE 블록 |
| `bridge/src/apme/store.ts` | 158-220 | view: `v_run_metrics`, `v_model_scorecard`, `v_category_scorecard` |
| `bridge/src/apme/runner.ts` | 216-340 | 7개 카테고리 rubric 템플릿 + axes |
| `bridge/src/apme/runner.ts` | 366 | task rollup rubric |
| `bridge/src/apme/http.ts` | 39-180 | 8개 HTTP 라우트 (`runs/run/scorecard/categories/rubric/vibe/recommend/tune`) |

## 부록 B — 외부 자료

- OpenTelemetry GenAI semantic conventions: https://opentelemetry.io/docs/specs/semconv/gen-ai/ — 현재 *Development*
- OTLP/HTTP spec: https://opentelemetry.io/docs/specs/otlp/
- App Review Guidelines 2.5.2 / 4.2.3 / 5.1.1: https://developer.apple.com/app-store/review/guidelines/

## 부록 C — `appstore-invariants.md` 와의 정합성

이 보고서의 권고는 다음과 호환:

- **2.5.2 (no subprocess)**: 권고 옵션 A·C 모두 daemon 내부 + Node bridge 내부에서만 동작. 신규 subprocess 없음.
- **4.2.3 (no companion-install copy)**: SetupNeededCard 카피 변경 없음. Settings 신규 필드는 옵션 A·C 에서 추가되지 않음 (옵션 B 만 해당, 거절).
- **CI verifier**: `verify-appstore-archive.sh` 는 .app Mach-O 의 forbidden-string 검사. 옵션 A·C 는 Node 측이라 .app 미터치 → 자동 통과. 옵션 B 가 macOS App Store 빌드 안에 들어가더라도 outbound HTTP 호출은 forbidden string 목록에 없음 → 통과 (단 5.1.1 별개 이슈).
- **Feature matrix**: 옵션 A·C 는 [docs/appstore-feature-matrix.md](appstore-feature-matrix.md) 에 새 row 추가 불요(내부 구현 변경). 옵션 B 채택 시에만 row 추가.
