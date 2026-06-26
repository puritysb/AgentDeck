# App Store Connect Metadata Draft — AgentDeck Dashboard

Copy-ready text for the App Store Connect submission form. Each field respects Apple's character limits. Korean first (primary localization), English second.

**Platforms**: macOS 15+ · iOS/iPadOS 17+
**Bundle ID**: `bound.serendipity.agent.deck`
**App Category**: Primary — Developer Tools · Secondary — Productivity
**Content Rating**: 4+ (no user-generated content, no ads, no external links to age-restricted sites)
**Price**: Free

---

## 🇰🇷 Korean (Primary)

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
Claude Code와 opt-in Codex/OpenClaw 세션을 Mac + iPad에서 실시간으로 모니터링하세요. 상태, 도구 호출, 사용량, APME 평가 리포트까지 한 화면에서. 하드웨어 없이도 풍부한 터레리움 UI + Device Preview 제공.
```

### Description (4000자)

```
AgentDeck Dashboard는 AI 코딩 에이전트(Claude Code, Codex, OpenClaw)를 위한 실시간 모니터링 & 평가 앱입니다.

"Stop Chatting. Start Steering."

Claude Code를 비롯한 AI 에이전트를 터미널에서 돌릴 때, 세션 진행 상태 · 호출한 도구 · 토큰 사용량 · 평가 점수 같은 핵심 정보를 대시보드 한 화면에서 확인하세요. 작업 중인 터미널 창에 집착하지 않고, 에이전트를 "대화"가 아닌 "조종" 하는 경험을 제공합니다.

═══ 주요 기능 ═══

• 실시간 세션 모니터링
Claude Code 훅, opt-in Codex lifecycle 훅, OpenClaw Gateway 이벤트를 60fps 터레리움 UI로 렌더링. 세션마다 크리처가 헤엄치며, 처리 중이거나 답을 기다리는 상태가 즉시 보입니다.

• iPad/iPhone 원격 대시보드 (무료 컴패니언 앱)
Bonjour 자동 발견 + QR 페어링. Mac에서 돌아가는 에이전트 세션을 침대 머리맡 iPad에서도 볼 수 있습니다.

• APME 에이전트 성능 평가
각 에이전트 턴을 카테고리(coding/debug/docs/planning/review/research/conversation)별 루브릭으로 채점. Apple Intelligence Foundation Models (on-device, 무료) 또는 Anthropic API(opt-in) 선택 가능. LLM-only 평가는 App Store 빌드에서 완전 로컬.

• Device Preview 14개 기기 갤러리
하드웨어 없이도 Stream Deck+ / Apple Watch / iPad / E-ink / ESP32 / Pixoo / TUI 등 14가지 기기에서 에이전트가 어떻게 보이는지 미리보기.

• OpenClaw Gateway 네이티브 연동
OpenClaw Gateway를 로컬에서 실행 중이면 자동으로 operator 클라이언트로 페어링. 세션 목록, 모델 카탈로그, 도구 승인 요청을 대시보드에서 처리.

• Claude Code Hook 옵션 설치
첫 실행 시 자동 설치하지 않습니다. 설정에서 "Enable Claude Code Hooks…" 버튼을 누르고 ~/.claude/settings.local.json을 직접 선택해야 훅이 등록됩니다. 언제든 제거 가능.

• 음성 입력 (제로 셋업)
Apple on-device 음성 인식(SFSpeechRecognizer)으로 음성 → 텍스트 → 에이전트 전송. 추가 설치 없이 작동하며, 녹음은 기기를 떠나지 않습니다.

═══ 하드웨어 연동 (선택 사항) ═══

• Ulanzi D200H Deck Dock (USB HID, 14키)
• Divoom Pixoo 매트릭스 디스플레이 (Wi-Fi)
• ESP32 스테이터스 디스플레이 (USB 시리얼로 Wi-Fi 프로비저닝)
• Elgato Stream Deck+ (Elgato 소프트웨어 + AgentDeck 플러그인 필요)

하드웨어가 없어도 핵심 대시보드 기능을 바로 사용할 수 있습니다.

═══ 프라이버시 & 보안 ═══

• 모든 데이터는 기기에 보관. 어떤 원격 서버에도 전송되지 않습니다.
• 음성 녹음은 Apple on-device 인식으로 처리, 네트워크 사용 안 함.
• App Sandbox 완전 준수 (Apple Review Guideline 2.5.2).
• 로컬 WebSocket(포트 9120)은 기기/같은 Wi-Fi의 iPad 컴패니언 연결 전용. 외부 접근 없음.
• Claude Code 훅 설치는 사용자 명시적 동의 + security-scoped bookmark 기반.

═══ 개발자 전용 확장 (선택) ═══

개발 워크플로우에서 Android ADB 브리징, OpenCode 모니터링, Codex/OpenCode PTY 세션 실행, APME Layer 1 결정적 평가 같은 고급 자동화가 필요한 사용자는 별도의 개발자 도구 영역에서 이 기능들을 사용합니다. AgentDeck 앱 자체는 이런 외부 도구의 설치나 실행을 요구하거나 유도하지 않으며, 앱 내 핵심 기능은 설치 직후 바로 사용 가능합니다.

═══ 시스템 요구사항 ═══

• macOS 15 Sequoia 이상
• iOS 17 / iPadOS 17 이상
• Apple Silicon 또는 Intel Mac

AgentDeck은 설치 직후 Device Preview, iPad 페어링, 음성 입력, APME 리포트, 선택 하드웨어 상태 출력을 바로 사용할 수 있습니다. Claude Code 훅을 켜면 사용자가 이미 실행 중인 세션 이벤트가 대시보드에 자동으로 표시됩니다.

═══ 비관계 고지 & 상표 ═══

AgentDeck는 독립적인 프로젝트이며 Anthropic, OpenAI, Google, SST, Corsair/Elgato, DIVOOM, Ulanzi 및 언급된 기타 제3자와 제휴, 후원, 또는 승인 관계가 없습니다. Claude™, Claude Code™, Codex™, Stream Deck®, Pixoo® 등 모든 상표는 각 소유자의 자산입니다. 자세한 상표 고지와 오픈소스 라이선스는 [ATTRIBUTION.md](https://github.com/puritysb/AgentDeck/blob/master/ATTRIBUTION.md)를 참고하세요.
```

### Keywords (100자, 쉼표로 구분, 공백 무관)

```
claude code,ai,agent,dashboard,stream deck,monitoring,apme,openclaw,codex,ipad,companion,developer
```

### What's New (for v1.0.0, 4000자)

```
🎉 AgentDeck Dashboard 첫 App Store 출시

핵심 기능:
• Mac + iPad 동시 페어링 (Bonjour 자동 + QR 백업)
• Claude Code + opt-in Codex/OpenClaw 세션 실시간 모니터링
• APME 에이전트 성능 평가 (Apple Intelligence on-device)
• Device Preview 14개 기기 갤러리
• OpenClaw Gateway 네이티브 연동 (self-gen Ed25519 identity + Keychain)
• 음성 입력 (Apple SFSpeech on-device, 추가 설치 없음)
• ESP32 Wi-Fi 프로비저닝 & Pixoo 매트릭스 관리 인앱 시트
• 첫 실행 3-pane 온보딩

피드백 환영: puritysb@gmail.com
```

---

## 🇺🇸 English

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
Monitor Claude Code plus opt-in Codex/OpenClaw sessions in real time on Mac + iPad. See state, tools, usage, and APME quality scores at a glance. Rich terrarium UI + 14-device preview — no hardware required.
```

### Description (4000 chars)

```
AgentDeck Dashboard is a real-time monitoring and evaluation companion for AI coding agents — Claude Code, Codex, and OpenClaw.

"Stop Chatting. Start Steering."

When you run AI coding agents from the terminal, you lose sight of what's actually happening — which tools they're calling, how close they are to a token limit, whether they're waiting for your input or crunching on a 10-step plan. AgentDeck pulls that state out of the terminal and into a dashboard you can glance at, so you can steer your agents instead of babysitting chat windows.

═══ Highlights ═══

• Live session monitoring
Claude Code hooks, opt-in Codex lifecycle hooks, and OpenClaw Gateway events render as 60fps terrarium creatures. Each session has its own creature that swims, processes, or awaits input — you see the status at a glance.

• Free iPad/iPhone companion dashboard
Auto-discovers your Mac over Wi-Fi via Bonjour. QR pairing fallback for different-subnet setups. Keep your agents visible on a second screen without alt-tabbing.

• APME agent performance evaluation
Each finished agent turn is scored against category-specific rubrics (coding/debug/docs/planning/review/research/conversation). Default backend is Apple Intelligence Foundation Models — on-device, free, zero network. Anthropic API is available as an opt-in paid backend.

• 14-device preview gallery
See how AgentDeck renders on Stream Deck+, Apple Watch, iPad, E-ink readers, ESP32 displays, Divoom Pixoo matrices, and a TUI terminal — all without owning any of the hardware.

• OpenClaw Gateway native integration
Auto-pairs as an operator client when an OpenClaw Gateway is running locally (ws://127.0.0.1:18789). Self-generated Ed25519 identity stored in Keychain; the Gateway-issued device token is reused on reconnect.

• Opt-in Claude Code hooks
AgentDeck does not auto-install hooks. Go to Settings → Claude Code Hooks → Enable, pick your ~/.claude/settings.local.json file explicitly, and we'll register 7 hooks to stream session state into the dashboard. Remove any time.

• Voice input with zero install
Press the voice button, speak your command, and Apple's on-device SFSpeechRecognizer transcribes locally — no whisper.cpp, no sox, no model download. Audio never leaves your device.

═══ Optional hardware integrations ═══

• Ulanzi D200H Deck Dock (USB HID, 14 keys)
• Divoom Pixoo LED matrix (Wi-Fi)
• ESP32 status displays (USB serial Wi-Fi provisioning)
• Elgato Stream Deck+ (requires Elgato software + AgentDeck plugin)

None of the hardware is required. The dashboard is fully functional on a stock Mac.

═══ Privacy and security ═══

• All data stays on your device. Nothing is sent to remote servers.
• Voice recordings are transcribed on-device; the audio never leaves your Mac/iPad.
• Fully App Sandbox compliant (Apple Review Guideline 2.5.2).
• The local WebSocket (port 9120) accepts connections only from this Mac and your paired iOS companion on the same Wi-Fi. No external exposure.
• Claude Code hook installation requires explicit NSOpenPanel consent + a security-scoped bookmark.

═══ Optional developer extensions ═══

Developer workflows involving Android ADB bridging, OpenCode monitoring, Codex/OpenCode PTY session launch, or APME Layer 1 deterministic scoring rely on a separate developer toolchain. AgentDeck itself never requires or prompts for those tools; the core app works out of the box after install.

═══ System requirements ═══

• macOS 15 Sequoia or later
• iOS 17 / iPadOS 17 or later
• Apple Silicon or Intel Mac

AgentDeck works immediately after install with Device Preview, iPad pairing, voice input, APME reports, and optional hardware status output. Turn on Claude Code hooks when you want sessions you already run to appear in the dashboard.

═══ Independence and trademarks ═══

AgentDeck is an independent project and is not affiliated with, endorsed by, or sponsored by Anthropic, OpenAI, Google, SST, Corsair/Elgato, DIVOOM, Ulanzi, or any other third parties mentioned. Claude™, Claude Code™, Codex™, Stream Deck®, Pixoo®, and all other trademarks referenced are the property of their respective owners. See ATTRIBUTION.md (https://github.com/puritysb/AgentDeck/blob/master/ATTRIBUTION.md) for full trademark notices and open-source licenses.
```

### Keywords (100 chars)

```
claude code,ai,agent,dashboard,monitoring,apme,openclaw,codex,ipad,stream deck,developer
```

### What's New (v1.0.0, 4000 chars)

```
🎉 AgentDeck Dashboard — first App Store release

What's in v1.0:
• Mac + iPad simultaneous pairing (Bonjour auto + QR fallback)
• Real-time Claude Code + opt-in Codex/OpenClaw session monitoring
• APME agent performance scoring (Apple Intelligence on-device)
• Device Preview gallery of 14 hardware targets
• OpenClaw Gateway native pairing (self-generated Ed25519 in Keychain)
• Voice input via Apple SFSpeech — no install, fully on-device
• ESP32 Wi-Fi provisioning & Pixoo matrix in-app sheets
• 3-pane first-launch onboarding

Feedback welcome: puritysb@gmail.com
```

---

## Screenshot Guidance

Capture these 4 macOS + 6 iOS screens. Ideally from a running session with 2-3 active agents so the terrarium looks alive.

### macOS (4 shots, 1280×800 minimum, 2560×1600 recommended)

1. **Dashboard** — full window with terrarium + session list + tank status. Ideal: 2 Claude Code sessions + 1 Codex session running, mix of processing/idle states.
2. **Device Preview** — sidebar with 7 categories visible, Stream Deck+ selected, agent=claude-code state=processing so the preview renders a vivid creature.
3. **Settings → Hardware Setup** — Hardware Setup GroupBox expanded, ESP32 + Pixoo entry buttons visible.
4. **Reports (APME Dashboard)** — after running a few sessions so the Runs tab has rows. Show a row selected with right-side detail visible.

### iOS (6 shots, iPhone 6.7" + iPad 13")

1. **iPhone portrait**: Dashboard with live session terrarium.
2. **iPhone portrait**: Connection settings with paired Mac shown.
3. **iPhone portrait**: First-launch onboarding pane 1 ("Stop Chatting. Start Steering.").
4. **iPad landscape**: Full dashboard with session list + terrarium + timeline.
5. **iPad landscape**: Scan QR fullscreen view (aimed at Mac QR).
6. **iPad portrait**: Settings → Connection showing successful pair.

Generate via:
```bash
# On Mac with the build running + sessions active
screencapture -o -R "x,y,w,h" ~/Desktop/macos-1-dashboard.png

# iOS via Xcode Simulator
# Window → Take Screenshot (⌘S)
```

---

## App Privacy (ASC form)

Data collection answers for the App Privacy questionnaire:

| Question | Answer |
|---|---|
| Does your app collect data? | **No** |
| Data types collected | None |
| Data used for tracking | None |
| Third-party SDKs collecting data | None |

Backed by:
- No analytics SDKs (no Firebase, no Amplitude, no Segment).
- No crash reporting beyond macOS/iOS system-level (users opt into via Apple, not via us).
- APME scores stored in on-device SQLite only.
- Voice audio processed on-device.

---

## App Review Notes

Use the contents of `apple/APP_REVIEW_NOTES.md` verbatim in the App Store Connect "Review Notes" field. Key points the reviewer will care about:

1. Why we run a local WebSocket server (iPad companion).
2. OpenClaw Gateway-native pairing (self-generated identity, not file read).
3. Zero bundled subprocess — verified by `apple/scripts/verify-appstore-archive.sh` in CI.
4. Claude Code hooks are opt-in via NSOpenPanel.
5. Voice uses Apple on-device SFSpeech (no network, no whisper).

No demo account required — the app doesn't have user accounts. Reviewer can open "Preview Devices" to see the UI without any real session, and verify in the empty Dashboard copy that AgentDeck never directs users to launch Terminal scripts or external CLIs.

---

## Copyright / Support URL

| Field | Value |
|---|---|
| Copyright | `© 2026 Serendipity Bound` (or your legal entity) |
| Support URL | `https://github.com/puritysb/AgentDeck/issues` |
| Marketing URL | `https://github.com/puritysb/AgentDeck` |
| Privacy Policy URL | `https://puritysb.github.io/AgentDeck/#privacy` |

If you don't have a privacy policy page yet, the minimum Apple-acceptable content:
- State: "AgentDeck Dashboard does not collect, store, or transmit any personal data."
- List every user-visible capability (microphone, speech recognition, local network, USB device, app groups) and what they're used for.
- Contact email for questions.
