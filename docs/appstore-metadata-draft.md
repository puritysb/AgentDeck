# App Store Connect Metadata Draft — AgentDeck Dashboard

Copy-ready text for the App Store Connect submission form. Each field respects Apple's character limits. The existing app record's primary language is English (U.S.); Korean is the additional localization.

**Platforms**: macOS 26+ · iOS/iPadOS 17+
**Bundle ID**: `bound.serendipity.agent.deck`
**App Category**: Primary — Developer Tools · Secondary — Productivity
**Content Rating**: 4+ (no user-generated content, no ads, no external links to age-restricted sites)
**Price**: Free

---

## 🇰🇷 Korean (Additional localization)

### App Name (30자)

```
AgentDeck Dashboard
```

### Subtitle (30자)

```
AI 코딩 에이전트 실시간 대시보드
```

### Promotional Text (170자, 심사 없이 수정 가능)

```
Claude Code와 opt-in Codex/OpenCode/OpenClaw 세션을 Mac + iPad에서 모니터링하세요. 상태, 도구 호출, 사용량, APME 평가까지 한 화면에서. 하드웨어 없이도 17개 Device Preview 제공.
```

### Description (4000자)

```
AgentDeck Dashboard는 AI 코딩 에이전트(Claude Code, Codex, OpenCode, OpenClaw)를 위한 실시간 모니터링 & 평가 앱입니다. 제출 앱에 내장된 샌드박스 Swift daemon이 대시보드, 훅 이벤트, 로컬 네트워크 페어링을 직접 처리합니다.

"Stop Chatting. Start Steering."

Claude Code를 비롯한 AI 에이전트를 터미널에서 돌릴 때, 세션 진행 상태 · 호출한 도구 · 토큰 사용량 · 평가 점수 같은 핵심 정보를 대시보드 한 화면에서 확인하세요. 작업 중인 터미널 창에 집착하지 않고, 에이전트를 "대화"가 아닌 "조종" 하는 경험을 제공합니다.

═══ 주요 기능 ═══

• 실시간 세션 모니터링
Claude Code 훅, opt-in Codex lifecycle 훅, OpenCode 로컬 서버 이벤트, OpenClaw Gateway 이벤트를 터레리움 UI로 렌더링. 세션마다 크리처가 헤엄치며, 처리 중이거나 답을 기다리는 상태가 즉시 보입니다.

• iPad/iPhone 원격 대시보드 (무료 컴패니언 앱)
Bonjour 자동 발견 + QR 페어링. Mac에서 돌아가는 에이전트 세션을 침대 머리맡 iPad에서도 볼 수 있습니다.

• APME 에이전트 성능 평가
각 에이전트 턴을 카테고리별 루브릭으로 채점. 기본 Apple Intelligence Foundation Models 백엔드는 온디바이스·무료이며, 사용자가 직접 켜는 Anthropic API 백엔드도 선택할 수 있습니다.

• Device Preview 17개 디스플레이 갤러리
하드웨어 없이도 Stream Deck / Stream Deck+ / D200H / iPad / InkDeck e-ink / ESP32 보드 / Pixoo / Timebox / iDotMatrix / TUI 등 Swift 앱의 17가지 디스플레이 프리뷰를 확인할 수 있습니다.

• OpenClaw Gateway 네이티브 연동
OpenClaw Gateway를 로컬에서 실행 중이면 자동으로 operator 클라이언트로 페어링. 세션 목록, 모델 카탈로그, 도구 승인 요청을 대시보드에서 처리.

• Claude Code Hook 옵션 설치
첫 실행 시 자동 설치하지 않습니다. 설정에서 "Enable Claude Code Hooks…" 버튼을 누르고 ~/.claude/settings.json을 직접 선택해야 훅이 등록됩니다. 언제든 제거 가능.

• 음성 입력 (제로 셋업)
Apple on-device 음성 인식(SFSpeechRecognizer)으로 음성 → 텍스트 → 에이전트 전송. 추가 설치 없이 작동하며, 녹음은 기기를 떠나지 않습니다.

═══ 하드웨어 연동 (선택 사항) ═══

• Ulanzi D200H Deck Dock (Ulanzi Studio 플러그인)
• Divoom Pixoo 매트릭스 디스플레이 (Wi-Fi)
• Divoom Timebox Mini / iDotMatrix (Bluetooth LE)
• 지원 ESP32 스테이터스 디스플레이 (USB 시리얼 모니터링 및 Wi-Fi 프로비저닝)
• Elgato Stream Deck+ (Elgato 소프트웨어 + AgentDeck 플러그인 필요)

하드웨어가 없어도 핵심 대시보드 기능을 바로 사용할 수 있습니다.

═══ 프라이버시 & 보안 ═══

• 기본 동작과 평가 데이터는 기기에 보관. 사용자가 직접 켠 선택 연동만 해당 로컬 서비스 또는 API와 통신합니다.
• 음성 녹음은 Apple on-device 인식으로 처리, 네트워크 사용 안 함.
• App Sandbox 완전 준수 (Apple Review Guideline 2.5.2).
• 로컬 WebSocket(포트 9120)은 기기/같은 Wi-Fi의 iPad 컴패니언 연결 전용. 외부 접근 없음.
• Claude Code 훅 설치는 사용자 명시적 동의 + security-scoped bookmark 기반.

═══ 시스템 요구사항 ═══

• macOS 26 이상
• iOS 17 / iPadOS 17 이상
• Apple Silicon 또는 Intel Mac (온디바이스 Foundation Models 평가는 지원되는 Apple Silicon Mac 필요)

AgentDeck은 별도 AgentDeck 실행 파일 없이 Device Preview, iPad 페어링, 음성 입력, APME 리포트, 선택 하드웨어 상태 출력을 제공합니다. Claude Code/Codex 훅이나 OpenCode/OpenClaw 연동을 사용자가 켜면 이미 실행 중인 세션 이벤트가 표시됩니다.

═══ 비관계 고지 & 상표 ═══

AgentDeck는 독립적인 프로젝트이며 Anthropic, OpenAI, Google, SST, Corsair/Elgato, DIVOOM, Ulanzi 및 언급된 기타 제3자와 제휴, 후원, 또는 승인 관계가 없습니다. Claude™, Claude Code™, Codex™, Stream Deck®, Pixoo® 등 모든 상표는 각 소유자의 자산입니다. 자세한 상표 고지와 오픈소스 라이선스는 [ATTRIBUTION.md](https://github.com/puritysb/AgentDeck/blob/master/ATTRIBUTION.md)를 참고하세요.
```

### Keywords (100자, 쉼표로 구분, 공백 무관)

```
claude code,ai,agent,dashboard,stream deck,monitoring,apme,openclaw,codex,ipad,companion,developer
```

### What's New (for v0.2.3, 4000자)

```
🎉 AgentDeck Dashboard 첫 App Store 출시

핵심 기능:
• Mac + iPad 동시 페어링 (Bonjour 자동 + QR 백업)
• Claude Code + opt-in Codex/OpenClaw 세션 실시간 모니터링
• APME 에이전트 성능 평가 (Apple Intelligence on-device)
• Swift 앱 내장 Device Preview 17개 디스플레이 갤러리
• OpenClaw Gateway 네이티브 연동 (self-gen Ed25519 identity + Keychain)
• 음성 입력 (Apple SFSpeech on-device, 추가 설치 없음)
• ESP32 Wi-Fi 프로비저닝 & Pixoo 매트릭스 관리 인앱 시트
• 첫 실행 3-pane 온보딩

피드백 환영: puritysb@gmail.com
```

---

## 🇺🇸 English (Primary)

### App Name (30 chars)

```
AgentDeck Dashboard
```

### Subtitle (30 chars)

```
Real-time AI agent dashboard
```

### Promotional Text (170 chars, editable without review)

```
Monitor Claude Code and opt-in Codex/OpenCode/OpenClaw sessions on Mac + iPad. See state, tools, usage, and APME scores, plus 17 display previews.
```

### Description (4000 chars)

```
AgentDeck Dashboard is a real-time monitoring and evaluation companion for Claude Code, Codex, OpenCode, and OpenClaw. Its sandboxed, built-in Swift daemon handles the dashboard, hook events, and local pairing.

"Stop Chatting. Start Steering."

AgentDeck pulls tool activity, token usage, and attention state out of terminal windows and into a dashboard you can understand at a glance.

═══ Highlights ═══

• Live session monitoring
Claude Code hooks, opt-in Codex lifecycle hooks, OpenCode local-server events, and OpenClaw Gateway events render as terrarium creatures. Each session swims, processes, or awaits input so status is clear at a glance.

• Free iPad/iPhone companion dashboard
Auto-discovers your Mac over Wi-Fi via Bonjour. QR pairing fallback for different-subnet setups. Keep your agents visible on a second screen without alt-tabbing.

• APME agent performance evaluation
Finished turns are scored against category-specific rubrics. The default Apple Intelligence Foundation Models backend is on-device and free; Anthropic API is an opt-in alternative.

• 17-display preview gallery
Preview the Swift app's built-in layouts for Stream Deck, Stream Deck+, Ulanzi D200H, iPad, InkDeck e-ink, ESP32 displays, Pixoo, Timebox Mini, iDotMatrix, and TUI — without owning the hardware.

• OpenClaw Gateway native integration
Auto-pairs as an operator client when an OpenClaw Gateway is running locally (ws://127.0.0.1:18789). Self-generated Ed25519 identity stored in Keychain; the Gateway-issued device token is reused on reconnect.

• Opt-in Claude Code hooks
AgentDeck never auto-installs hooks. Enable them in Settings and explicitly select ~/.claude/settings.json. Remove them any time.

• Voice input with zero install
Press the voice button, speak your command, and Apple's on-device SFSpeechRecognizer transcribes locally — no whisper.cpp, no sox, no model download. Audio never leaves your device.

═══ Optional hardware integrations ═══

• Ulanzi D200H Deck Dock (Ulanzi Studio plugin)
• Divoom Pixoo LED matrix (Wi-Fi)
• Divoom Timebox Mini / iDotMatrix (Bluetooth LE)
• Supported ESP32 status displays (USB serial monitoring and Wi-Fi provisioning)
• Elgato Stream Deck+ (requires Elgato software + AgentDeck plugin)

None of the hardware is required. The dashboard is fully functional on a stock Mac.

═══ Privacy and security ═══

• Core operation and evaluation data stay on your device. Only integrations you explicitly enable contact their configured local service or API.
• Voice recordings are transcribed on-device; the audio never leaves your Mac/iPad.
• Fully App Sandbox compliant (Apple Review Guideline 2.5.2).
• The local WebSocket (port 9120) accepts connections only from this Mac and your paired iOS companion on the same Wi-Fi. No external exposure.
• Claude Code hook installation requires explicit NSOpenPanel consent + a security-scoped bookmark.

═══ System requirements ═══

• macOS 26 or later
• iOS 17 / iPadOS 17 or later
• Apple Silicon or Intel Mac (a supported Apple Silicon Mac is required for on-device Foundation Models scoring)

AgentDeck needs no separate AgentDeck executable. Device Preview, iPad pairing, voice input, APME reports, and optional hardware status output are provided by the app. Enable Claude Code/Codex hooks or OpenCode/OpenClaw integration when you want existing sessions to appear.

═══ Independence and trademarks ═══

AgentDeck is independent and is not affiliated with or endorsed by the third parties mentioned. All trademarks belong to their owners. Full notices: https://github.com/puritysb/AgentDeck/blob/master/ATTRIBUTION.md
```

### Keywords (100 chars)

```
claude code,ai,agent,dashboard,monitoring,apme,openclaw,codex,ipad,stream deck,developer
```

### What's New (v0.2.3, 4000 chars)

```
🎉 AgentDeck Dashboard — first App Store release

What's in v0.1:
• Mac + iPad simultaneous pairing (Bonjour auto + QR fallback)
• Real-time Claude Code + opt-in Codex/OpenClaw session monitoring
• APME agent performance scoring (Apple Intelligence on-device)
• Built-in Swift Device Preview gallery of 17 display targets
• OpenClaw Gateway native pairing (self-generated Ed25519 in Keychain)
• Voice input via Apple SFSpeech — no install, fully on-device
• ESP32 Wi-Fi provisioning & Pixoo matrix in-app sheets
• 3-pane first-launch onboarding

Feedback welcome: puritysb@gmail.com
```

---

## Screenshot Guidance

The upload-ready set is in `apple/appstore-submission/screenshots/`. Do not upload the older raw captures in `apple/appstore-screenshots/`; several are duplicate onboarding frames or non-App-Store desktop captures.

Current upload-ready set: 3 macOS + 3 iPhone + 3 iPad screenshots. Capture a privacy-safe live dashboard later if desired; screenshots must not expose project names, auth tokens, local IP addresses, or USB paths.

### macOS upload order (2880×1800)

1. **Device Preview** — hardware-optional value proposition with Stream Deck+ selected.
2. **Agent evaluation (APME)** — Foundation Models selected and Apple Intelligence ready.
3. **Integrations** — opt-in Claude/Codex observation and local account status handled by the Swift app.

### iPhone and iPad upload order

Use the same story on both devices: value proposition → supported agents → automatic Mac discovery and QR fallback. iPhone files are 1284×2778 (6.5-inch); iPad files are 2064×2752 (13-inch).

An active dashboard can be added later only after replacing real project/session names with a clean demo session and verifying that the frame contains no token, IP address, local path, or device identifier.

---

## App Privacy (ASC form)

Data collection answers for the App Privacy questionnaire:

| Question | Answer |
|---|---|
| Does your app collect data? | **Yes** — only when the user enables the optional Anthropic API evaluation backend |
| Data types collected | Other User Content; Product Interaction |
| Linked to the user | Yes (the user supplies an Anthropic API credential) |
| Purpose | App Functionality |
| Data used for tracking | None |
| Advertising/marketing use | None |

Backed by:
- No analytics SDKs (no Firebase, no Amplitude, no Segment).
- No crash reporting beyond macOS/iOS system-level (users opt into via Apple, not via us).
- APME scores are stored locally. The default Foundation Models backend is on-device.
- When the user selects Anthropic API, the agent turn content required for evaluation and associated API interaction data are sent to Anthropic for app functionality and may be linked through the user's API credential.
- Voice audio processed on-device.

---

## App Review Notes

Use the contents of `apple/APP_REVIEW_NOTES.md` verbatim in the App Store Connect "Review Notes" field. Key points the reviewer will care about:

1. Why we run a local WebSocket server (iPad companion).
2. OpenClaw Gateway-native pairing (self-generated identity, not file read).
3. Zero bundled subprocess — verified by `apple/scripts/verify-appstore-archive.sh` in CI.
4. Claude Code hooks are opt-in via NSOpenPanel.
5. Voice uses Apple on-device SFSpeech (no network, no whisper).

No demo account required — the app doesn't have user accounts. Reviewer can open "Preview Devices" to see the Swift app's 17 built-in layouts without a real session, then enable only the agent integrations they want to test.

---

## Copyright / Support URL

| Field | Value |
|---|---|
| Copyright | `© 2026 Serendipity Bound` |
| Support URL | `https://github.com/puritysb/AgentDeck/issues` |
| Marketing URL | `https://github.com/puritysb/AgentDeck` |
| Privacy Policy URL | `https://puritysb.github.io/AgentDeck/#privacy` |

The public policy must disclose the optional Anthropic API transfer as well as microphone, speech recognition, local network, user-selected files, USB/Bluetooth hardware access, credentials, and the contact email.
