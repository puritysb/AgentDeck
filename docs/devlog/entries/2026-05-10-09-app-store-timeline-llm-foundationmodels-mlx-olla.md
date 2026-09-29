# 2026-05-10 — App Store timeline LLM 요약 (FoundationModels → MLX → Ollama → heur)

### 문제

App Store macOS 빌드의 timeline `chat_end` 행은 휴리스틱 한 줄 추출
(`extractTopicHint`)만 사용했음. 같은 위치에서 Node bridge 빌드는
MLX(`Qwen3.6-35B-A3B-4bit`)로 LLM 요약을 생성하므로 standalone App Store
앱은 dashboard / device renderer 가 "응답 첫 줄 잘라낸" 라벨만 받음.
인프라(`apple/AgentDeck/Daemon/Timeline/TimelineSummarizer.swift` MLX/Ollama
체인 + `ApmeJudgeFoundationModels.swift` Apple Intelligence 어댑터)는
이미 깔려 있었지만 호출 site 가 없는 dead code 였음.

추가 제약: App Store 심사 invariants(2.5.2 self-contained / 4.2.3 no
install nudge) 와 `feedback_cost_sensitive_defaults.md` (default 백엔드
무료) 를 모두 보존해야 함.

### 해결

- `TimelineSummarizer.summarize(_:provider:)` 시그니처 변경 — `(text, kind)?`
  반환. `SummaryProvider` enum 추가 (`auto / appleIntelligence / mlx /
  heuristic`). `auto` 체인은 FoundationModels → MLX → Ollama → 휴리스틱
  순서, 명시 픽은 short-circuit. FoundationModels 분기는
  `ApmeJudgeFoundationModels.swift` 의 `#if canImport(FoundationModels)` +
  `#available(macOS 26.0, *)` + `SystemLanguageModel.default.availability`
  패턴 그대로 미러.
- `DaemonTimelineEntry` + `claudeCodeEntryDict` 에 `summaryKind: String?`
  추가. 디스크 round-trip + WS broadcast 양쪽에서 보존되도록 plumbing.
  앞서 dict serializer 가 필드를 빠뜨려 dashboard 가 항상 nil 로 디코드한
  버그를 stop-time review 가 잡음.
- `appendClaudeCodeChatEnd` (DaemonServer.swift:4612) + `appendCodexChatEnd`
  (DaemonServer.swift:4491): chat_response 즉시 broadcast 유지, chat_end
  빌드 + add + broadcast 를 `Task { ... }` 로 감싸 LLM await 후 실행.
  캡처는 by-value 라 main-actor 의 후속 cache cleanup 이 in-flight Task 를
  영향 안 줌.
- `AppPreferences.timelineSummaryProvider` (default `"auto"`) +
  `writeTimelineSummaryProviderToSettingsJson` 으로 `~/.agentdeck/
  settings.json` `timeline.summary.provider` 키에 미러.
- Settings → Advanced 에 `.timelineSummary` 신규 섹션. APME judge backend
  picker 패턴 그대로 (FoundationModels 비가용 시 inline grayed reason,
  MLX 행 secondary text 는 APME 와 동일 카피).
- `TimelineStripView::turnRow` 의 chat_end 에 한 줄 백엔드 pill (AI / MLX
  / Ollama / Heur). 휴리스틱도 라벨링 — App Store deploy target 이 macOS
  15 인데 FoundationModels 는 macOS 26+ 라, 대다수 사용자가 항상 휴리스
  틱 분기로 떨어짐. 휴리스틱을 숨기면 picker 변경의 가시 신호가 0 이라
  Codex review 가 두 번 잡음.
- `docs/appstore-feature-matrix.md` 행 추가, `apple/APP_REVIEW_NOTES.md`
  단락 추가.

### 핵심 설계 결정

- **FoundationModels 를 chain head 에 둠** — APME 와 동일 정책. 무료/오프
  라인/sandbox 안전. macOS 15 deploy target 에서 `#available` gate 로
  graceful fallback. 별도 OS 분기 코드 없음.
- **Ollama 는 `auto` 체인의 내부 fallback, picker 노출 X** — APME 가
  Ollama 옵션을 노출 안 한 선례 따름. 사용자 picker 는 의도/기대치
  표현용; 자동 fallback 이 항상 휴리스틱으로 떨어짐을 보장하면 충분.
- **chat_end Task 감싸기 vs upsert 두 단계** — 단순함을 택함. chat_end 는
  dimmed metadata 행이라 1-5s 지연이 사용자 체감에 무해. chat_response
  의 본문 broadcast 는 즉시 유지하므로 응답 지연감 없음.
- **summaryKind 값은 `"appleIntelligence" | "mlx" | "ollama" |
  "heuristic"` 4종, `"none"` 미사용** — 기존 UI 가 `"none"` 을 "detail
  표시 억제" 시그널로 쓰지만 새 경로는 항상 raw 에 의미있는 라벨이 들어
  가서 억제할 게 없음. detail-redundancy 검사가 그 자리를 대체.
- **App Store 심사 invariant**: subprocess 0건, install-nudge 카피 0건,
  Anthropic API 등 paid backend 는 picker 미포함. `verify-appstore-archive
  .sh` main Mach-O 스캔 통과.
- **stop-time review 두 라운드 회고**:
  (1) `claudeCodeEntryDict` 에서 `summaryKind` 빠뜨린 silent serialization
  bug 는 unit test 도, build 도 잡지 못함. dict-shape mismatch 는
  broadcast/disk 양쪽 round-trip 을 눈으로 추적해야 보임.
  (2) "휴리스틱 pill 은 노이즈" 라는 디자인 판단이 deploy target 현실
  (macOS 15 ↔ FoundationModels macOS 26)을 무시. 가시 시그널이 절대 안
  나오는 사용자 그룹의 존재를 못 보면 review 가 잡아준다.

---
