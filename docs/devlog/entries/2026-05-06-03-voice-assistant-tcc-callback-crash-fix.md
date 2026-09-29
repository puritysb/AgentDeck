# 2026-05-06 — Voice assistant TCC callback crash fix

### 문제

macOS AgentDeck 이 daemon startup 이후 `CodexOTel`/D200H 로그를 마지막으로 조용히 종료되는 사례가
반복됐다. 진단 번들의 `.ips` crash report 는 `EXC_BREAKPOINT` / `_swift_task_checkIsolatedSwift` 를
가리켰고, faulting stack 은 `DaemonVoiceAssistant.start()` 에서 만든 speech authorization callback 이
TCC 백그라운드 큐에서 호출되는 경로였다. `DaemonVoiceAssistant` 가 `@MainActor` 이므로 Swift 6 런타임이
actor-isolated closure 를 잘못된 executor 에서 실행한다고 판단해 trap 한 것이다.

### 해결

- 마이크/음성 인식 권한 요청 callback literal 을 `@MainActor` 타입 밖의 `VoicePermissionRequester` 로
  이동했다.
- `SFSpeechRecognizer.recognitionTask` callback 도 non-actor `VoiceSpeechTranscriber` 로 분리했다.
- speech result continuation 은 `@unchecked Sendable` lock box 로 감싸 다중 callback resume 과 Swift 6
  concurrent-capture 오류를 함께 막았다.

### 검증

- `bash scripts/capture-apple-diagnostics.sh --tail 1500 --last 30m` 로 crash report 를 수집했다.
- `xcodebuild build -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/AgentDeckDerivedDataVoiceCrash CODE_SIGNING_ALLOWED=NO` 성공.
- 수정 빌드 실행 후 `http://127.0.0.1:9120/health` 응답을 확인했고, startup 이후 OTel/D200H/hook 이벤트를
  지나 daemon 이 계속 살아있는 것을 확인했다.
- `git diff --check` 성공.

---
