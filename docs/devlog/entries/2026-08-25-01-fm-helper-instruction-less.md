# 2026-08-25 — fm-helper에 평가용 instruction-less 세션과 출력 상한을 연다

model-eval의 Apple Foundation Models 호출을 OpenClaw 공통 하네스에 연결하려면
OpenAI 호환 어댑터가 헬퍼에 두 조건을 전달할 수 있어야 했다. 기존 헬퍼는 instructions가
빠지면 AgentDeck 판정용 strict-JSON 지시문을 자동으로 넣었고, `maxTokens`도 Foundation
Models의 `GenerationOptions`까지 내려가지 않았다.

`HelperRequest`에 선택적 `instructionsMode`와 `maximumResponseTokens`를 추가했다.
`instructionsMode: "none"`은 실제 instruction-less `LanguageModelSession`을 만들고,
출력 상한은 1–4,096 범위로 정규화해 `GenerationOptions.maximumResponseTokens`에 전달한다.
두 필드가 없는 AgentDeck 기존 호출은 strict-JSON 기본값과 온도 0을 그대로 유지한다.
health 응답의 `generationProtocol: 2`로 평가 어댑터가 오래된 캐시 바이너리를 감지할 수 있다.
`GenerationError`의 컨텍스트 초과·언어 거부·rate limit·동시 요청·refusal도 각 enum 이름으로
내보내 어댑터와 평가 기록이 원인을 보존한다.

검증: `fm-helper-build.test.ts` 7개 통과, macOS 26 SDK 실컴파일 통과, 새 바이너리 health가
`generationProtocol: 2`를 반환했다. model-eval의 localhost 어댑터를 거친
`openclaw infer model run --model apple-fm/on-device` 실호출에서 요청 문자열을 정확히 돌려받았다.

---
