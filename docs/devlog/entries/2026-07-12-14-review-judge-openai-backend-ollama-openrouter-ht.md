# 2026-07-12 — REVIEW judge: OpenAI 호환 backend(Ollama/OpenRouter/…) + HTTP-only 로컬 감지 + on-device 실패 진단

### 배경
사용자 지적 3건: ① 방금 리뷰가 어떤 모델인지(답: Apple Intelligence 온디바이스), ② Ollama/OpenRouter 같은 사실상 표준 환경을 유연 지원, ③ 온보딩에서 사용자 환경에 있는 걸 자연스럽게 연결, ④ App Store 심사 안전. 추가로 발견한 버그: REVIEW 패널이 "judge 없음" 셋업 가이드를 reason="available"로 잘못 띄움 — 실은 judge는 있는데 온디바이스 컨텍스트(~4k) 초과로 호출 실패한 것.

### on-device judge 실패 진단 분리 (선행 fix, 커밋 3ff44df1)
FoundationModels judge가 nil 반환 시 셋업 가이드로 오분류하던 것을 분리: 트래젝토리 캡 20k→6k자 축소(온디바이스 컨텍스트), `judgeThrowing` 도입으로 실제 에러 노출, "judge 있는데 호출 실패"는 런타임 에러 패널(설정 갭 아님). `unavailableReason`을 구체 상태(device-not-eligible/not-enabled/model-not-ready)로 교체.

### OpenAI 호환 backend (커밋 66b72e95)
MLX가 이미 OpenAI chat-completions 호환이므로 **범용 `openai` backend 하나**로 Ollama(:11434)/LM Studio(:1234)/vLLM/llama.cpp + 클라우드 OpenRouter/Together/Groq를 전부 커버. config=endpoint+선택 Bearer apiKey+model(blank=auto-detect via /v1/models 또는 Ollama /api/tags). Node `callOpenAICompatible`+Swift `ApmeJudgeOpenAI`(throwing 변형 포함). endpoint 정규화(bare host/base+v1/full URL 허용). probe=카탈로그 도달+모델 해석 가능+원격은 키 필수.

### HTTP-only 로컬 감지 + 온보딩
`judge-detect.ts`/`ApmeJudgeDetect.swift`: loopback 표준 포트를 GET으로 프로브해 실제 사용 가능 모델을 광고하는 서버만 반환. **서브프로세스/CLI 프로브 없음**(ollama list 등) — App Store 서명 데몬에서 그대로 동작. `GET /apme/judge/detect` 양 데몬. REVIEW 셋업 가이드(Node 브라우저 HTML + Swift 네이티브 패널)가 **감지된 로컬 서버를 최상단에** 붙여넣기용 config와 함께 표시, 이어서 랭킹(API→OpenRouter→OpenClaw→로컬→Apple). macOS Settings judge picker에 "OpenAI-compatible" 옵션+endpoint/model/key 필드+프리셋 버튼(Ollama/LM Studio/OpenRouter)+"Detect local servers" 버튼. AppPreferences가 apme.judge.endpoint/model/apiKey 저장.

### App Store 안전
APP_REVIEW_NOTES: OpenAI 호환 어댑터+loopback 감지를 network-client 전용으로 문서화(서브프로세스 없음, 설치 유도 없음; 카피는 "이미 돌리는 서버를 가리켜라"). REVIEW opt-in+온디바이스 기본은 무설정 동작이라 provider 없어도 앱 안 깨짐.

### 검증
- vitest 100파일 1764/1764(신규: openAIChatUrl 정규화, 감지-provider 가이던스). xcodebuild AgentDeck_macOS BUILD SUCCEEDED. design lint 905(불변).
- **실기**: 새 데몬 `/apme/judge/detect`가 이 Mac의 Ollama(:11434, bge-m3)+MLX(:8800, Qwen3.6-35B)를 HTTP-only로 감지 확인. 커밋 3ff44df1+66b72e95 (origin/master).
