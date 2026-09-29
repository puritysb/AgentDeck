# 2026-08-01 — 데크 hold-to-talk: 은퇴한 Voice 다이얼의 부활 (호스트 연계 PTT)

음성 라운드트립(ips10/T-Embed)을 "마이크·스피커 없는" 데크 표면으로 확장.
스트림덱 키는 트리거만 하고 오디오는 호스트가 담당한다 — Marketplace 제출 전
제거됐던 Voice 다이얼(AppleScript로 iTerm2 마이크 권한 차용 + Homebrew sox +
whisper 모델이라 클린 머신에서 침묵 실패)의 능력을 의존성 제로 스택으로 복원.

- **fm-helper `record`**: AVAudioEngine 캡처→16kHz mono PCM16 WAV.
  `record_stop`/`record_cancel`이 stdin 후속 라인으로 도착하므로 detached
  Task로 실행(직렬 read 루프 비차단), stdout는 write 락, maxMs 타이머는
  generation 가드(이전 녹음의 타이머가 다음 녹음을 죽이는 레이스 차단).
  실기 검증: 1.5s max_duration 캡처 + mid-capture stop 양쪽 확인.
- **데몬 `voice` 명령**(플러그인 WS, sessionId 추가): 게이트웨이 first-dibs보다
  먼저 인터셉트. 캡처→`finishVoiceCapture` 재사용(gateway/observed 터미널
  주입/session-bridge 사다리 그대로), reply sink는 `host:speaker`
  (`audio_out`+`audio_host` capability) — `speakReplyTo`가 audio_host 타깃은
  WAV 합성 우회하고 `speak`(AVSpeechSynthesizer)로 직접 재생. `voice_result`는
  `voice_state` 브로드캐스트로 변환되어 데크가 진행 상태를 렌더.
- **플러그인 VOICE 키**: 상세뷰(managed CC idle 프리셋 5번째 + observed
  claude/codex idle REVIEW 옆) hold-to-talk. keyDown=begin, keyUp=end,
  250ms 미만 탭=cancel(키클랙 오탐 방지), 페이지 전환 mid-hold=cancel.
  상태별 스타일은 UI 토큰만 사용(디자인 린트 베이스라인 불변). 부수 수정:
  CC 프리셋 materialization이 `localAction`을 누락해 managed idle REVIEW가
  dead key였던 것 복구. SD+ 8키에선 VOICE가 마지막 콘텐츠 슬롯을 차지해
  MODEL 상태 카드가 밀려남(INFO 리드아웃에 모델명 유지, 15키에선 그대로).
- **Swift 데몬 패리티 (같은 날 2차)**: "App Store 앱에선 불가능"은 오판이었다 —
  `DaemonVoiceAssistant`가 이미 AVFoundation+Speech 전체 스택을 증명하고
  있었다. 신규 `Daemon/Voice/DaemonPttVoice.swift`(@MainActor; 명시적
  begin/end, VAD 무개입, 입력 네이티브 포맷으로 녹음 — SFSpeech가 임의
  레이트를 읽으므로 리샘플 불필요) + DaemonServer `voice` 명령 인터셉트
  (어댑터 라우팅보다 먼저) + `broadcastRaw`의 timeline_event 초크포인트에서
  chat_response arming 매칭(`pttRawSessionId`=shared rawSessionId 미러,
  10분 TTL) + `speakableReply` Swift 미러. observed Claude 전달만 의미가
  다르다: CLI 데몬=터미널 주입(즉시), 앱 데몬=queued-directive 사다리
  (샌드박스 계약). start↔stop 레이스로 pttBusy가 잠기는 경로도 가드.
  macOS 타깃 빌드 그린, xcodegen 재생성.
- **D200H (같은 날 2차)**: 같은 UX를 공유 레이아웃에 — `buildSessionDeck`
  상세뷰에 VOICE 타일(managed idle 프리셋 뒤 + observed claude/codex/
  opencode). D200H는 단일 `run` 발화라 hold 불가 → **탭 토글**(tap to
  talk → ● tap to send). `DeckView.voiceState`로 스타일링하고 **렌더
  시그니처에 voiceState 포함**(누락하면 정확히 그 리페인트가 dedup에
  먹히는 재발 패턴). 관측 테스트 2건은 새 계약(REVIEW+VOICE)으로 갱신.
- T-Embed/ips10은 기존 그대로; Apple/Android 앱 자체 마이크 경로는 별도 트랙.

---
