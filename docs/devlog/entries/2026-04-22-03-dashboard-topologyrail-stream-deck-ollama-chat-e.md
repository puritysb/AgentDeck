# 2026-04-22 — Dashboard TopologyRail 다듬기: Stream Deck+ 노출 + Ollama chat/embed 분리 + Claude hooks LED + self-probe 버그

### 문제

한 디버깅 세션에서 6건의 대시보드 UX/동작 버그가 연달아 드러남:

1. **Claude row "not connected"** — App Store sandbox 는 `~/.claude/` OAuth token 을 못 읽어 `oauthConnected=false` 고정. TopologyRail + IntegrationStatusEvaluator 가 이 신호만 보고 Claude 를 "awaiting" 으로 찍어 훅이 정상인데도 경고 카드 노출.
2. **Downstream 에 D200H + Pixoo 만 표시** — 4개 ESP32 가 연결돼 `/health` HTTP 에선 보이는데 state_update 에선 누락. `buildModuleHealthSync` 가 SerialModule 의 async snapshot 을 await 못 해 `serial: {available: true}` 만 내보냄.
3. **여러 세션 중 하나만 써도 모든 creature 가 헤엄침** — per-session state 를 handleHookEvent 에서 올바르게 세팅하는데도 10초마다 refreshSessions 가 돌며 `enrichSessionsWithState` 가 **hook-synthesized 세션 (port=9120) 의 /health 를 self-probe** 하고 받아온 글로벌 state 로 각 세션 state 를 덮어씀.
4. **Ollama "installed, no models loaded"** — daemon 이 `/api/ps` 만 조회해 VRAM 상주 안 하는 embedding 모델 (bge-m3 등) 을 "로드 안 됨" 으로 보여줌. 사용자 관점 혼란.
5. **ProviderRow subtitle 말줄임** — 2개 이상 MLX 모델이나 OpenClaw pairing deviceId 힌트가 tail-clipped.
6. **USB serial 라벨** — `"ESP32 · ulanzi_tc001"` 원시 board 문자열 + 펌웨어 버전이 장황함.

그리고 "왜 Stream Deck+ 는 Downstream 에 없나" — 플러그인이 WS 로 daemon 에 접속은 하지만 자기소개 없이 익명 viewer 로 취급돼 렌더 경로가 아예 없었음.

### 해결

**Self-probe 버그 (#3)** `enrichSessionsWithState` 에서 `session.port == self.port` 이면 probe 스킵 — hook-synthesized 세션은 이미 handleHookEvent 에서 올바른 per-session state 가져오므로 덮어쓸 이유 없음. Node CLI bridge 세션 (port 9121+) 은 여전히 정상 probe.

**Serial sync gap (#2)** `cachedSerialStatus` 추가 + 5초 polling task 가 async `serialStatusSnapshot()` 를 미리 당겨 저장. `buildModuleHealthSync` 가 캐시 읽어 full `connections` payload 를 state_update 에 포함.

**Claude hooks LED (#1)** TopologyRail `claudeRow` + IntegrationStatusEvaluator `claudeStatus` 둘 다 `hooksOn || oauthOn` 기준으로 "connected" 판정. App Store 훅 기반 연결이 정상 반영됨.

**Ollama chat/embed (#4)** `probeOllama` 가 `/api/tags` + `/api/ps` 를 병렬 fetch 해 name 매칭으로 sizeVram overlay. `classifyOllamaKind` 가 `details.family` ("bert", "nomic-bert" 등) + name pattern (`bge-`, `-embed`, `gte-`, `e5-`) 으로 chat/embed 태깅. `OllamaModel.kind` 필드 추가. UI 는 두 그룹을 `"Chat: X (loaded), Y\nEmbed: Z"` 두 줄로 분리 렌더.

**Subtitle wrap (#5)** ProviderRow Text modifier 를 `.lineLimit(1).truncationMode(.tail)` → `.lineLimit(nil).fixedSize(horizontal:false, vertical:true)` 로 교체. 한 줄짜리는 그대로, 길면 자연 줄바꿈.

**USB serial 라벨 (#6)** firmware version suffix 제거, `ulanzi_tc001` board → `"Ulanzi TC001"` 브랜드명 매핑 (TopologyRail + MenuBarTopologyList 둘 다).

**Stream Deck+ 노출** 신규 PluginCommand `client_register` 를 shared/protocol 에 추가: 리치 UI 클라이언트가 접속 직후 `{clientType, devices: [{id, name, family, columns, rows}]}` 자기소개. 플러그인 `connMgr.on('connected')` 에서 `streamDeck.devices` 를 family 매핑 (type 7→`streamdeckplus` 등) 해 전송. Daemon 은 `cachedStreamDeck` 에 저장 + 30s eviction task 에 piggyback 한 120s TTL 로 stale 정리. `ModuleHealthState.streamDeck` + `StreamDeckHealth`/`StreamDeckDeviceInfo` 모델 + `BridgeEventParser` 확장 + TopologyRail `streamDeckSection` (Downstream 첫 번째). family 기반 display label + `{cols}×{rows} keys` detail.

### 핵심 설계 결정

- **Self-probe 회피 원칙**: hook-synthesized session 은 daemon 자기 port 를 공유하므로 enrichment probe 가 self-loop. 이런 경우 probe 스킵하고 in-memory per-session state 를 authoritative 로 사용 — "작성자가 state 를 알고 있으면 re-fetch 하지 않는다".
- **`client_register` 프로토콜 원시타입**: 리치 UI 클라이언트의 self-announce 경로. 지금은 Stream Deck+ 만 쓰지만 향후 Android companion, 외부 iOS pairing 도 같은 경로로 announce → daemon 의 `handleClientRegister` switch 에 분기 추가하면 끝.
- **Ollama `kind` 분류 휴리스틱**: `details.family` 가 1차 신호 (bert/nomic-bert/distilbert/roberta 가 embed), name pattern 이 fallback. Ollama 의 구/신 버전 응답 스키마 모두 수용.
- **Sandbox-async gap 처리 패턴**: sync broadcast path 에서 async 모듈 snapshot 이 필요하면 cached mirror + 5s polling 이 가장 단순. ESP32Serial (actor) 이 이 케이스.
- **UI 자기-gating**: 진단 copy ("Stream Deck not detected", "Install plugin" 등) 금지. 외부 신호가 없으면 섹션 자체를 숨김 — App Store Progressive Enhancement 원칙 일관.

---
