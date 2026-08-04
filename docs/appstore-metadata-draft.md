# App Store Connect Metadata Draft — AgentDeck

Copy-ready text for the App Store Connect submission form. Each field respects Apple's character limits. The existing app record's primary language is English (U.S.); Korean and Japanese are additional localizations.

**App Name is locale-specific**: the U.S. App Store already has an unrelated app using the name "AgentDeck", so the primary (English/U.S.) listing uses "AgentDeck Dashboard" instead. Korean and Japanese stores have no such conflict, so those localizations use the true brand name "AgentDeck" — matching every other surface (GitHub, README, marketing site).

**Promotional Text / Description / What's New are platform-specific**: this app record covers both a macOS App and an iOS App version in ASC, each with its own version-level metadata fields. The two platforms are *not* feature-equivalent — only the macOS app runs the in-process Swift daemon, APME scoring, voice input, and Claude Code hook installer. The iOS/iPadOS app mirrors live state from a paired Mac, while its built-in synthetic Device Preview remains available without a Mac. Each locale section below therefore gives separate **macOS App** and **iOS App** variants for these three fields. App Name, Subtitle, and Keywords stay shared across platforms.

**Platforms**: macOS 26+ · iOS/iPadOS 17+
**Bundle ID**: `bound.serendipity.agent.deck`
**App Category**: Primary — Developer Tools · Secondary — Productivity
**Content Rating**: 4+ (no user-generated content, no ads, no external links to age-restricted sites)
**Price**: Free

---

## 🇰🇷 Korean (Additional localization)

### App Name (30자)

```
AgentDeck
```

### Subtitle (30자)

```
모든 코딩 에이전트를 한 화면에
```

### Promotional Text (170자, 심사 없이 수정 가능)

**macOS App**

```
모든 AI 코딩 에이전트를 잔잔한 한 화면에 — Claude Code, Codex, OpenClaw. Stream Deck부터 e-ink까지 다양한 서피스에 상태를 실시간 프리뷰로. 하드웨어 없이 Mac 한 대로.
```

**iOS App**

```
Mac에서 돌아가는 에이전트 세션을 iPad·iPhone에서 그대로. 상태·도구 호출·사용량을 실시간으로 — 침대 머리맡에서도 필요한 순간을 놓치지 않습니다. 같은 Wi-Fi의 Mac에서 AgentDeck 실행이 필요합니다.
```

### Description (4000자)

**macOS App**

```
AgentDeck은 터미널 안에 갇혀 있던 코딩 에이전트(Claude Code, Codex, OpenCode, OpenClaw)를 잔잔한 화면 하나로 꺼내 놓는 실시간 모니터링 & 평가 앱입니다. 제출 앱에 내장된 샌드박스 Swift daemon이 세션 감시, 훅 이벤트, 로컬 네트워크 페어링을 로컬에서 직접 처리합니다.

"Stop Chatting. Start Steering."

조종은 당신의 터미널에서 — 관찰과 판단은 AgentDeck에서. 세션 여러 개를 병렬로 돌려도 지금 누가 일하고 있는지, 누가 답을 기다리는지 한눈에 보입니다. 세션 진행 상태 · 호출한 도구 · 토큰 사용량 · 평가 점수가 화면 하나에 다 들어오니, 황색 신호가 켜지는 순간에만 돌아오면 됩니다.

— 주요 기능 —

• 실시간 세션 모니터링
Claude Code 훅, opt-in Codex lifecycle 훅, OpenCode 로컬 서버 이벤트, OpenClaw Gateway 이벤트를 터레리움 UI로 렌더링. 세션마다 크리처가 헤엄치며, 처리 중이거나 답을 기다리는 상태가 즉시 보입니다.

• iPad/iPhone 컴패니언 (무료)
Bonjour 자동 발견 + QR 페어링. Mac에서 돌아가는 세션을 침대 머리맡 iPad에서도 그대로 지켜보세요.

• APME 에이전트 성능 평가
각 에이전트 턴을 카테고리별 루브릭으로 채점. 기본 Apple Intelligence Foundation Models 백엔드는 온디바이스·무료이며 네트워크를 쓰지 않습니다. 사용자가 직접 엔드포인트를 지정하는 opt-in 원격 백엔드(Anthropic API, OpenAI 호환 서버, MLX 로컬 서버)도 선택할 수 있으며, 이 경우에만 평가 대상 턴 내용이 사용자가 고른 엔드포인트로 전송됩니다.

• Device Preview 갤러리
하드웨어 없이도 Stream Deck+, e-ink, ESP32 보드, LED 매트릭스, iPad, TUI 등 앱 내장 프리뷰를 확인하세요. 지원하는 모든 서피스를 실시간 프리뷰로: https://puritysb.github.io/AgentDeck/

• OpenClaw Gateway 네이티브 연동
OpenClaw Gateway를 로컬에서 실행 중이면 자동으로 operator 클라이언트로 페어링. 세션 목록, 모델 카탈로그, 도구 승인 요청을 직접 처리.

• Claude Code Hook 옵션 설치
첫 실행 시 자동 설치하지 않습니다. 설정에서 "Enable Claude Code Hooks…" 버튼을 누르고 ~/.claude/settings.json을 직접 선택해야 훅이 등록됩니다. 언제든 제거 가능.

• 음성 입력 (제로 셋업)
Apple on-device 음성 인식(SFSpeechRecognizer)으로 음성 → 텍스트 → 에이전트 전송. 추가 설치 없이 작동하며, 녹음은 기기를 떠나지 않습니다.

— 하드웨어 연동 (선택 사항) —

• Ulanzi D200H Deck Dock (Ulanzi Studio 플러그인)
• Divoom Pixoo 매트릭스 디스플레이 (Wi-Fi)
• Divoom Timebox Mini / iDotMatrix (Bluetooth LE)
• 지원 ESP32 스테이터스 디스플레이 (USB 시리얼 모니터링 및 Wi-Fi 프로비저닝)
• Elgato Stream Deck+ (Elgato 소프트웨어 + AgentDeck 플러그인 필요)

하드웨어가 없어도 핵심 기능은 그대로 — 맨 Mac 한 대로 바로 시작할 수 있습니다.

— 프라이버시 & 보안 —

• 기본 동작과 평가 데이터는 기기에 보관. 사용자가 직접 켠 선택 연동만 해당 로컬 서비스 또는 API와 통신합니다.
• 음성 녹음은 Apple on-device 인식으로 처리, 네트워크 사용 안 함.
• App Sandbox 완전 준수 (Apple Review Guideline 2.5.2).
• 로컬 WebSocket(포트 9120)은 이 기기 또는 같은 Wi-Fi의 페어링된 iPad 컴패니언 연결만 허용. 외부 접근 없음.
• Claude Code 훅 설치는 사용자 명시적 동의 + security-scoped bookmark 기반.

— 시스템 요구사항 —

• macOS 26 이상
• iOS 17 / iPadOS 17 이상
• Apple Silicon 또는 Intel Mac (온디바이스 Foundation Models 평가는 지원되는 Apple Silicon Mac 필요)

AgentDeck은 별도 AgentDeck 실행 파일 없이 Device Preview, iPad 페어링, 음성 입력, APME 리포트, 선택 하드웨어 상태 출력을 제공합니다. Claude Code/Codex 훅이나 OpenCode/OpenClaw 연동을 사용자가 켜면 이미 실행 중인 세션 이벤트가 표시됩니다.

— 비관계 고지 & 상표 —

AgentDeck은 독립적인 프로젝트이며 Anthropic, OpenAI, Google, SST, Corsair/Elgato, DIVOOM, Ulanzi, Waveshare 및 언급된 기타 제3자와 제휴, 후원, 또는 승인 관계가 없습니다. Claude™, Claude Code™, Codex™, Stream Deck®, Pixoo® 등 모든 상표는 각 소유자의 자산입니다. 자세한 상표 고지와 오픈소스 라이선스: https://github.com/puritysb/AgentDeck/blob/master/ATTRIBUTION.md
```

**iOS App**

```
AgentDeck(iOS)는 Mac에서 실행 중인 AgentDeck과 페어링해, 돌아가는 세션을 실시간으로 그대로 보여주는 컴패니언 앱입니다. 라이브 세션에는 같은 Wi-Fi의 Mac이 필요하지만, 내장 Device Preview는 Mac 없이도 바로 둘러볼 수 있습니다.

"Stop Chatting. Start Steering."

Mac에서 Claude Code 등 AI 에이전트를 돌리는 동안, 세션 진행 상태 · 호출한 도구 · 토큰 사용량 · 평가 점수 같은 핵심 정보를 iPad·iPhone 화면에서 실시간으로 확인하세요. 자리를 옮겨도 필요한 순간을 놓치지 않습니다.

— 주요 기능 —

• 실시간 세션 모니터링
Mac의 Claude Code 훅, opt-in Codex lifecycle 훅, OpenCode 로컬 서버 이벤트, OpenClaw Gateway 이벤트를 터레리움 UI로 렌더링. 세션마다 크리처가 헤엄치며, 처리 중이거나 답을 기다리는 상태가 즉시 보입니다.

• Mac 페어링 (무료)
Bonjour 자동 발견 + QR 페어링. Mac에서 돌아가는 세션을 침대 머리맡 iPad에서도 그대로 지켜보세요.

• APME 평가 점수 열람
Mac에서 계산된 에이전트 턴 평가 점수를 카테고리별 루브릭과 함께 확인. 평가 자체는 Mac에서 수행되며, iOS 앱은 결과를 표시만 합니다.

• OpenClaw Gateway 상태 미러링
Mac에 페어링된 OpenClaw Gateway의 세션 목록·모델 카탈로그·도구 승인 요청 상태를 읽기 전용으로 확인.

• 하드웨어 상태 미러링
Ulanzi D200H, 지원 ESP32 보드, Divoom Pixoo/Timebox Mini, iDotMatrix 등 Mac에 연결된 하드웨어의 상태를 읽기 전용으로 확인. Mac이 없을 때도 내장 Device Preview에서 기기·에이전트·상태·세션 수를 바꿔 합성 화면을 확인할 수 있습니다. 음성 입력, Claude Code 훅 설치, 하드웨어 직접 제어는 Mac 앱 전용 기능입니다.

— 프라이버시 & 보안 —

• 이 앱 자체는 데이터를 수집하지 않으며, 같은 Wi-Fi의 페어링된 Mac과만 통신합니다.
• App Sandbox 완전 준수 (Apple Review Guideline 2.5.2).
• 로컬 네트워크 접근은 Mac 탐색·페어링 전용이며, 외부 서버와 통신하지 않습니다.

— 시스템 요구사항 —

• iOS 17 / iPadOS 17 이상
• 같은 Wi-Fi 네트워크의 Mac에서 AgentDeck이 실행 중이어야 함

— 비관계 고지 & 상표 —

AgentDeck은 독립적인 프로젝트이며 Anthropic, OpenAI, Google, SST, Corsair/Elgato, DIVOOM, Ulanzi, Waveshare 및 언급된 기타 제3자와 제휴, 후원, 또는 승인 관계가 없습니다. Claude™, Claude Code™, Codex™, Stream Deck®, Pixoo® 등 모든 상표는 각 소유자의 자산입니다. 자세한 상표 고지와 오픈소스 라이선스: https://github.com/puritysb/AgentDeck/blob/master/ATTRIBUTION.md
```

### Keywords (100자, 쉼표로 구분, 공백 무관)

```
claude code,ai,agent,dashboard,stream deck,monitoring,apme,openclaw,codex,ipad,companion,developer
```

### What's New (v1.0.2, macOS — 유지보수)

> 1.0.1이 공개된 적 없고 1.0.0이 라이브라, 1.0.0→1.0.2로 올라오는 사용자가 받는 1.0.1+1.0.2 수정을 합침 (App Store Swift 앱 실제 포함 항목만; ESP32 시리얼 등 CLI 전용 제외). 2026-07-24 심사 제출된 실제 문구.

```
안정성 개선 업데이트.

• 대시보드가 실행 시 내장 데몬에 안정적으로 연결됩니다
• 라이브 세션 화면의 드문 크래시 수정
• 텍스트 디코딩 버그로 비어 보이던 Codex 사용량 게이지 복구
• 관찰 중인 Codex·OpenCode·Antigravity 세션이 타임라인에서 사라지던 문제 수정

피드백은 언제든 환영합니다: admin@foundby.kr
```

### What's New (v1.0.2, iOS — 심사 대응 빌드)

```
연결 화면 안정성 개선.

• Mac 검색이 끝난 뒤 로딩 표시가 계속 돌던 문제 수정
• Mac을 찾지 못하면 명확한 종료 상태와 다시 검색 버튼 표시
• Mac 없이도 둘러볼 수 있는 내장 Device Preview 추가

피드백은 언제든 환영합니다: admin@foundby.kr
```

### What's New (v1.0.1, macOS — 유지보수)

```
안정성 개선 업데이트 — 첫 출시 이후의 신뢰성 수정입니다.

• 대시보드가 내장 데몬에 간헐적으로 연결되지 않던 문제 수정
• 세션 화면의 드문 크래시 수정
• 연결된 모든 서피스에서 디스플레이 절전 동작 일관화
• Codex 사용량 게이지 복구(텍스트 디코딩 버그로 비어 보이던 문제)
• 연결된 ESP32 시리얼 포트가 멈췄을 때 복구 안정성 향상

피드백은 언제든 환영합니다: admin@foundby.kr
```

### What's New (v1.0.1, iOS — 1.0.0 심사 통과 후 배포)

```
안정성 개선 업데이트.

• 페어링된 Mac의 화면이 켜져 있는 동안 iPad·iPhone 화면도 꺼지지 않아 실시간 상태가 계속 보입니다

피드백은 언제든 환영합니다: admin@foundby.kr
```

### What's New (for v1.0.0, 4000자)

**macOS App**

```
🎉 AgentDeck, 첫 App Store 출시 — 모든 코딩 에이전트를 한 화면에.

핵심 기능:
• Mac + iPad 동시 페어링 (Bonjour 자동 + QR 백업)
• Claude Code + opt-in Codex/OpenClaw 세션 실시간 모니터링
• APME 에이전트 성능 평가 (Apple Intelligence on-device)
• Swift 앱 내장 Device Preview 17개 디스플레이 갤러리
• OpenClaw Gateway 네이티브 연동 (self-gen Ed25519 identity + Keychain)
• 음성 입력 (Apple SFSpeech on-device, 추가 설치 없음)
• ESP32 Wi-Fi 프로비저닝 & Pixoo 매트릭스 관리 인앱 시트
• 첫 실행 3-pane 온보딩

피드백 환영: admin@foundby.kr
```

**iOS App**

```
🎉 AgentDeck iOS 컴패니언, 첫 App Store 출시

핵심 기능:
• Mac과 iPad/iPhone 동시 페어링 (Bonjour 자동 + QR 백업)
• Claude Code + opt-in Codex/OpenClaw 세션 실시간 모니터링 (Mac에서 릴레이)
• Mac에서 계산된 APME 평가 점수 열람
• OpenClaw Gateway 상태 읽기 전용 미러링
• ESP32/Pixoo/Timebox/D200H 하드웨어 상태 읽기 전용 미러링

같은 Wi-Fi의 Mac에서 AgentDeck이 실행 중이어야 동작합니다.

피드백 환영: admin@foundby.kr
```

---

## 🇯🇵 Japanese (Additional localization)

### App Name (30字)

```
AgentDeck
```

### Subtitle (30字)

```
エージェントを、静かな1画面に
```

### Promotional Text (170字, 審査なしで編集可能)

**macOS App**

```
すべてのAIコーディングエージェントを静かな1画面に — Claude Code、Codex、OpenClaw。Stream Deckからe-inkまで多彩なサーフェスに状態をライブプレビュー。ハードウェア不要。
```

**iOS App**

```
Macで動くエージェントセッションをiPad・iPhoneでそのまま。状態・ツール呼び出し・使用量をリアルタイムに — 呼ばれた瞬間を見逃しません。同一Wi-Fi上のMacでAgentDeckの実行が必要です。
```

### Description (4000字)

**macOS App**

```
AgentDeckは、ターミナルに閉じ込められていたコーディングエージェント（Claude Code、Codex、OpenCode、OpenClaw）を、静かな1つの画面に連れ出すリアルタイムモニタリング&評価アプリです。提出されたアプリに内蔵されたサンドボックス化されたSwift daemonが、セッション監視・フックイベント・ローカルネットワークペアリングをローカルで直接処理します。

"Stop Chatting. Start Steering."

操縦はあなたのターミナルで — 観察と判断はAgentDeckで。複数のセッションを並行して走らせても、いま誰が働いていて、誰が答えを待っているのかがひと目でわかります。セッションの進行状況・呼び出したツール・トークン使用量・評価スコアが1画面にまとまるので、琥珀色の合図が灯った瞬間だけ戻ればいい。

— 主な機能 —

• リアルタイムセッションモニタリング
Claude Codeフック、オプトインのCodexライフサイクルフック、OpenCodeのローカルサーバーイベント、OpenClaw GatewayイベントをテラリウムUIとしてレンダリング。セッションごとにクリーチャーが泳ぎ、処理中か応答待ちかが一目でわかります。

• iPad/iPhoneコンパニオン（無料）
Bonjour自動検出 + QRペアリング。Macで動いているセッションを、ベッドサイドのiPadからもそのまま見守れます。

• APMEエージェントパフォーマンス評価
各エージェントターンをカテゴリ別ルーブリックで採点。デフォルトのApple Intelligence Foundation Modelsバックエンドはオンデバイス・無料でネットワークを使用しません。ユーザーが自身のエンドポイントを指定するオプトインのリモートバックエンド（Anthropic API、OpenAI互換サーバー、ローカルMLXサーバー）も選択可能で、この場合のみ評価対象のターン内容がユーザーが選んだエンドポイントに送信されます。

• デバイスプレビューギャラリー
ハードウェアがなくても、Stream Deck+、e-ink、ESP32ボード、LEDマトリクス、iPad、TUIなどアプリ内蔵のプレビューを確認できます。対応するすべてのサーフェスをライブプレビューで: https://puritysb.github.io/AgentDeck/

• OpenClaw Gatewayネイティブ連携
OpenClaw Gatewayがローカルで実行中であれば自動的にオペレータークライアントとしてペアリング。セッション一覧、モデルカタログ、ツール承認リクエストを直接処理します。

• Claude Codeフックのオプトインインストール
初回起動時に自動インストールはされません。設定で「Enable Claude Code Hooks…」ボタンを押し、~/.claude/settings.jsonを明示的に選択する必要があります。いつでも削除可能です。

• 音声入力（ゼロセットアップ）
Appleのオンデバイス音声認識（SFSpeechRecognizer）で、音声→テキスト→エージェント送信。追加インストール不要で動作し、録音がデバイスから外に出ることはありません。

— ハードウェア連携（任意） —

• Ulanzi D200H Deck Dock（Ulanzi Studioプラグイン）
• Divoom Pixoo マトリックスディスプレイ（Wi-Fi）
• Divoom Timebox Mini / iDotMatrix（Bluetooth LE）
• 対応ESP32ステータスディスプレイ（USBシリアルモニタリング＆Wi-Fiプロビジョニング）
• Elgato Stream Deck+（Elgatoソフトウェア + AgentDeckプラグインが必要）

ハードウェアがなくても、コア機能はそのまま — Mac1台ですぐに始められます。

— プライバシー＆セキュリティ —

• 基本動作と評価データはデバイス内に保存。ユーザーが明示的に有効化した連携のみが、該当のローカルサービスまたはAPIと通信します。
• 音声録音はApple のオンデバイス認識で処理され、ネットワークは使用しません。
• App Sandboxに完全準拠（Apple Review Guideline 2.5.2）。
• ローカルWebSocket（ポート9120）は、同一デバイスまたは同一Wi-Fi上のペアリング済みiPadコンパニオン接続専用。外部からのアクセスはありません。
• Claude Codeフックのインストールには、ユーザーの明示的な同意とセキュリティスコープ付きブックマークが必要です。

— システム要件 —

• macOS 26以降
• iOS 17 / iPadOS 17以降
• Apple SiliconまたはIntel Mac（オンデバイスFoundation Models評価には対応するApple Silicon Macが必要）

AgentDeckは、別途AgentDeck実行ファイルなしで、デバイスプレビュー、iPadペアリング、音声入力、APMEレポート、任意のハードウェアステータス表示を提供します。Claude Code/Codexフックや OpenCode/OpenClaw連携をユーザーが有効にすると、既存のセッションイベントが表示されます。

— 非提携表示・商標について —

AgentDeckは独立したプロジェクトであり、Anthropic、OpenAI、Google、SST、Corsair/Elgato、DIVOOM、Ulanzi、Waveshare、その他言及される第三者と提携・後援・承認関係はありません。Claude™、Claude Code™、Codex™、Stream Deck®、Pixoo® など、すべての商標は各所有者の資産です。詳細な商標表記とオープンソースライセンス: https://github.com/puritysb/AgentDeck/blob/master/ATTRIBUTION.md
```

**iOS App**

```
AgentDeck（iOS）は、Macで動作するAgentDeckとペアリングし、動いているセッションをそのままリアルタイムに映し出すコンパニオンアプリです。ライブセッションには同一Wi-Fi上のMacが必要ですが、内蔵Device PreviewはMacなしでもすぐに確認できます。

"Stop Chatting. Start Steering."

MacでClaude CodeなどのAIエージェントを走らせている間、セッションの進行状況・呼び出したツール・トークン使用量・評価スコアといった重要な情報を、iPad・iPhone画面でリアルタイムに確認できます。席を離れても、呼ばれた瞬間を見逃しません。

— 主な機能 —

• リアルタイムセッションモニタリング
MacのClaude Codeフック、オプトインのCodexライフサイクルフック、OpenCodeのローカルサーバーイベント、OpenClaw GatewayイベントをテラリウムUIとしてレンダリング。セッションごとにクリーチャーが泳ぎ、処理中か応答待ちかが一目でわかります。

• Macペアリング（無料）
Bonjour自動検出 + QRペアリング。Macで動いているセッションを、ベッドサイドのiPadからもそのまま見守れます。

• APME評価スコアの閲覧
Macで計算されたエージェントターンの評価スコアを、カテゴリ別ルーブリックとともに確認できます。評価自体はMac側で実行され、iOSアプリは結果を表示するのみです。

• OpenClaw Gatewayステータスのミラーリング
MacにペアリングされたOpenClaw Gatewayのセッション一覧・モデルカタログ・ツール承認リクエストの状態を読み取り専用で確認できます。

• ハードウェアステータスのミラーリング
Ulanzi D200H、対応ESP32ボード、Divoom Pixoo/Timebox Mini、iDotMatrixなど、Macに接続されたハードウェアの状態を読み取り専用で確認できます。Macがない場合も、内蔵Device Previewでデバイス・エージェント・状態・セッション数を切り替えて合成画面を確認できます。音声入力、Claude Codeフックのインストール、ハードウェアの直接制御はMacアプリ専用です。

— プライバシー＆セキュリティ —

• このアプリ自体はデータを収集せず、同一Wi-Fi上のペアリング済みMacとのみ通信します。
• App Sandboxに完全準拠（Apple Review Guideline 2.5.2）。
• ローカルネットワークへのアクセスは、Macの検出・ペアリング専用であり、外部サーバーとは通信しません。

— システム要件 —

• iOS 17 / iPadOS 17以降
• 同一Wi-Fiネットワーク上のMacでAgentDeckが実行中であること

— 非提携表示・商標について —

AgentDeckは独立したプロジェクトであり、Anthropic、OpenAI、Google、SST、Corsair/Elgato、DIVOOM、Ulanzi、Waveshare、その他言及される第三者と提携・後援・承認関係はありません。Claude™、Claude Code™、Codex™、Stream Deck®、Pixoo® など、すべての商標は各所有者の資産です。詳細な商標表記とオープンソースライセンス: https://github.com/puritysb/AgentDeck/blob/master/ATTRIBUTION.md
```

### Keywords (100字, カンマ区切り, 空白は無視)

```
claude code,ai,エージェント,ダッシュボード,stream deck,monitoring,apme,openclaw,codex,ipad,developer
```

### What's New (v1.0.2, macOS — メンテナンス)

```
安定性の改善アップデート。

• ダッシュボードが起動時に内蔵デーモンへ確実に接続されるようになりました
• ライブセッション画面のまれなクラッシュを修正
• テキストデコードの不具合で空白になることがあったCodex使用量ゲージを復元
• 監視中のCodex・OpenCode・Antigravityセッションがタイムラインから消える問題を修正

フィードバックはいつでも歓迎します: admin@foundby.kr
```

### What's New (v1.0.2, iOS — 審査対応ビルド)

```
接続画面の安定性を改善しました。

• Macの検索完了後も読み込み表示が続く問題を修正
• Macが見つからない場合に、明確な完了状態と再検索ボタンを表示
• Macなしでも確認できる内蔵Device Previewを追加

フィードバックはいつでも歓迎します: admin@foundby.kr
```

### What's New (v1.0.1, macOS — メンテナンス)

```
安定性の改善アップデート — 初回リリース後の信頼性修正です。

• ダッシュボードが内蔵デーモンに時々つながらない問題を修正
• セッション画面のまれなクラッシュを修正
• 接続中のすべてのサーフェスで画面スリープの挙動を統一
• Codex使用量ゲージを復元（テキストデコードの不具合で空白になることがありました）
• 接続中のESP32シリアルポートが停止した際の復旧を強化

フィードバックはいつでも歓迎します: admin@foundby.kr
```

### What's New (v1.0.1, iOS — 1.0.0審査通過後に配信)

```
安定性の改善アップデート。

• ペアリング中のMacの画面が点いている間、iPad・iPhoneの画面も消えず、ライブ状態が見え続けます

フィードバックはいつでも歓迎します: admin@foundby.kr
```

### What's New (for v1.0.0, 4000字)

**macOS App**

```
🎉 AgentDeck、初のApp Storeリリース — エージェントを、静かな1画面に。

主な機能:
• Mac + iPad 同時ペアリング（Bonjour自動検出 + QRフォールバック）
• Claude Code + オプトインのCodex/OpenClawセッションのリアルタイムモニタリング
• APMEエージェントパフォーマンス評価（Apple Intelligenceオンデバイス）
• Swiftアプリ内蔵の17種デバイスプレビューギャラリー
• OpenClaw Gatewayネイティブ連携（自己生成Ed25519 identity + Keychain）
• 音声入力（Apple SFSpeechオンデバイス、追加インストール不要）
• ESP32 Wi-Fiプロビジョニング & Pixooマトリックス管理インアプリシート
• 初回起動時3ペインオンボーディング

フィードバック歓迎: admin@foundby.kr
```

**iOS App**

```
🎉 AgentDeck iOSコンパニオン、初のApp Storeリリース

主な機能:
• Mac・iPad/iPhone 同時ペアリング（Bonjour自動検出 + QRフォールバック）
• Claude Code + オプトインのCodex/OpenClawセッションのリアルタイムモニタリング（Macからリレー）
• Macで計算されたAPME評価スコアの閲覧
• OpenClaw Gatewayステータスの読み取り専用ミラーリング
• ESP32/Pixoo/Timebox/D200Hハードウェアステータスの読み取り専用ミラーリング

同一Wi-Fi上のMacでAgentDeckが実行中である必要があります。

フィードバック歓迎: admin@foundby.kr
```

---

## 🇺🇸 English (Primary)

### App Name (30 chars)

```
AgentDeck Dashboard
```

### Subtitle (30 chars)

```
Every agent, one calm surface
```

### Promotional Text (170 chars, editable without review)

**macOS App**

```
Every AI coding agent on one calm screen — Claude Code, Codex, OpenClaw — with live status previewed across every surface, Stream Deck to e-ink. No hardware required.
```

**iOS App**

```
Your Mac's agent sessions, live on iPad or iPhone — state, tool calls, and usage in real time. Know the moment you're needed. Requires AgentDeck running on your Mac.
```

### Description (4000 chars)

**macOS App**

```
AgentDeck Dashboard pulls your coding agents — Claude Code, Codex, OpenCode, and OpenClaw — out of the terminal and onto one calm screen. Its sandboxed, built-in Swift daemon handles session tracking, hook events, and local pairing.

"Stop Chatting. Start Steering."

You steer in your own terminal — AgentDeck keeps watch. Run sessions in parallel and still see who's working and who's waiting on you: progress, tool calls, token usage, and scores in one place. Come back only when the amber light asks.

— Highlights —

• Live session monitoring
Claude Code hooks, opt-in Codex lifecycle hooks, OpenCode local-server events, and OpenClaw Gateway events render as terrarium creatures. Each session swims, processes, or awaits input so status is clear at a glance.

• Free iPad/iPhone companion
Auto-discovers your Mac over Wi-Fi via Bonjour. QR pairing fallback for different-subnet setups. Keep your agents in view from a second screen without alt-tabbing.

• APME agent performance evaluation
Finished turns are scored against category-specific rubrics. The default Apple Intelligence Foundation Models backend is on-device, free, and uses no network. Opt-in remote backends you point at yourself — Anthropic API, any OpenAI-compatible server, or a local MLX server — are alternatives; only then does the evaluated turn content leave your Mac, to the endpoint you chose.

• Device preview gallery
Preview the app's built-in layouts for Stream Deck+, e-ink readers, ESP32 panels, LED matrices, iPad, and TUI — no hardware needed. See every supported surface, previewed live: https://puritysb.github.io/AgentDeck/

• OpenClaw Gateway native integration
Auto-pairs as an operator client when an OpenClaw Gateway is running locally (ws://127.0.0.1:18789). Self-generated Ed25519 identity stored in Keychain; the Gateway-issued device token is reused on reconnect.

• Opt-in Claude Code hooks
AgentDeck never auto-installs hooks. Enable them in Settings and explicitly select ~/.claude/settings.json. Remove them any time.

• Voice input with zero install
Press the voice button, speak your command, and Apple's on-device SFSpeechRecognizer transcribes locally — no whisper.cpp, no sox, no model download. Audio never leaves your device.

— Optional hardware integrations —

• Ulanzi D200H Deck Dock (Ulanzi Studio plugin)
• Divoom Pixoo LED matrix (Wi-Fi)
• Divoom Timebox Mini / iDotMatrix (Bluetooth LE)
• Supported ESP32 status displays (USB serial monitoring and Wi-Fi provisioning)
• Elgato Stream Deck+ (requires Elgato software + AgentDeck plugin)

None of the hardware is required — everything above runs on a stock Mac.

— Privacy and security —

• Core operation and evaluation data stay on your device. Only integrations you explicitly enable contact their configured local service or API.
• Voice recordings are transcribed on-device; the audio never leaves your Mac/iPad.
• Fully App Sandbox compliant (Apple Review Guideline 2.5.2).
• The local WebSocket (port 9120) accepts connections only from this Mac and your paired iOS companion on the same Wi-Fi. No external exposure.
• Claude Code hook installation requires explicit NSOpenPanel consent + a security-scoped bookmark.

— System requirements —

• macOS 26 or later
• iOS 17 / iPadOS 17 or later
• Apple Silicon or Intel Mac (a supported Apple Silicon Mac is required for on-device Foundation Models scoring)

AgentDeck needs no separate AgentDeck executable. Device Preview, iPad pairing, voice input, APME reports, and optional hardware status output are provided by the app. Enable Claude Code/Codex hooks or OpenCode/OpenClaw integration when you want existing sessions to appear.

— Independence and trademarks —

AgentDeck is independent and is not affiliated with or endorsed by Anthropic, OpenAI, Google, SST, Corsair/Elgato, DIVOOM, Ulanzi, Waveshare, or any other third party mentioned. All trademarks belong to their owners. Full notices: https://github.com/puritysb/AgentDeck/blob/master/ATTRIBUTION.md
```

**iOS App**

```
AgentDeck for iOS is a companion that pairs with AgentDeck running on your Mac and mirrors your running sessions live. Live sessions require a Mac on the same Wi-Fi, while the built-in Device Preview remains available without a Mac.

"Stop Chatting. Start Steering."

While Claude Code or another AI agent runs on your Mac, see session progress, tool calls, token usage, and evaluation scores live on your iPad or iPhone. Step away from the desk without missing the moment you're needed.

— Highlights —

• Live session monitoring
Your Mac's Claude Code hooks, opt-in Codex lifecycle hooks, OpenCode local-server events, and OpenClaw Gateway events render as terrarium creatures. Each session swims, processes, or awaits input so status is clear at a glance.

• Mac pairing (free)
Auto-discovers your Mac over Wi-Fi via Bonjour. QR pairing fallback for different-subnet setups. Keep your agents visible from a second screen without alt-tabbing.

• APME score viewing
See agent-turn evaluation scores, scored against category-specific rubrics on your Mac. Scoring itself runs on the Mac; the iOS app only displays the results.

• OpenClaw Gateway status mirror
View the session list, model catalog, and tool approval requests of an OpenClaw Gateway paired to your Mac, read-only.

• Hardware status mirror
View the status of hardware connected to your Mac — Ulanzi D200H, supported ESP32 boards, Divoom Pixoo/Timebox Mini, iDotMatrix — read-only. Without a Mac, the built-in Device Preview still lets you change the device, agent, state, and session count locally. Voice input, Claude Code hook installation, and direct hardware control are Mac-app-only features.

— Privacy and security —

• The app itself collects no data and only talks to your paired Mac on the same Wi-Fi network.
• Fully App Sandbox compliant (Apple Review Guideline 2.5.2).
• Local network access is used only to discover and pair with your Mac; no external server is contacted.

— System requirements —

• iOS 17 / iPadOS 17 or later
• A Mac on the same Wi-Fi network running AgentDeck

— Independence and trademarks —

AgentDeck is independent and is not affiliated with or endorsed by Anthropic, OpenAI, Google, SST, Corsair/Elgato, DIVOOM, Ulanzi, Waveshare, or any other third party mentioned. All trademarks belong to their owners. Full notices: https://github.com/puritysb/AgentDeck/blob/master/ATTRIBUTION.md
```

### Keywords (100 chars)

```
claude code,ai,agent,dashboard,monitoring,apme,openclaw,codex,ipad,stream deck,developer
```

### What's New (v1.0.2, macOS — maintenance)

macOS ships 1.0.2 as a reliability update on build 3901 (the `apple-v1.0.2` CI
upload; build number is CI-owned — never set it by hand). Because 1.0.1 never
shipped publicly and 1.0.0 is live, this What's New folds the 1.0.1 and 1.0.2
fixes together (only the ones that ship in the App Store Swift app — CLI-daemon-only
items like ESP32 serial recovery are excluded). Submitted for review 2026-07-24.

```
Reliability update.

• The dashboard now reliably connects to its built-in daemon on launch
• Fixed a rare crash in the live session view
• Restored the Codex usage gauge that a text-decoding bug could leave blank
• Observed Codex, OpenCode, and Antigravity sessions no longer drop off the timeline

Thanks for the feedback — keep it coming: admin@foundby.kr
```

### What's New (v1.0.2, iOS — review response build)

```
Connection-screen reliability update.

• Fixed the loading indicator continuing after Mac discovery completed
• Added a clear no-Mac state with a Search Again action
• Added a built-in Device Preview that works without a paired Mac

Thanks for the feedback — keep it coming: admin@foundby.kr
```

### What's New (v1.0.1, macOS — maintenance)

Only the macOS app ships 1.0.1 now; the iPhone/iPad companion carries its fix on a
later train while 1.0.0 finishes review. Build 3702.

```
Maintenance update — reliability fixes for the first release.

• Fixed the dashboard sometimes failing to connect to its own built-in daemon
• Fixed a rare crash in the live session view
• Display-sleep now behaves consistently across every connected surface
• Restored the Codex usage gauge (a text-decoding bug could blank it)
• More resilient recovery when a connected ESP32's serial port stalls

Thanks for the early feedback — keep it coming: admin@foundby.kr
```

### What's New (v1.0.1, iOS — ships after 1.0.0 review clears)

```
Reliability update.

• The screen now stays awake while your paired Mac's display is on, so live status stays visible

Thanks for the early feedback — keep it coming: admin@foundby.kr
```

### What's New (v1.0.0, 4000 chars)

**macOS App**

```
🎉 AgentDeck Dashboard — first App Store release. Every agent on one calm screen.

What's in v1.0.0:
• Mac + iPad simultaneous pairing (Bonjour auto + QR fallback)
• Real-time Claude Code + opt-in Codex/OpenClaw session monitoring
• APME agent performance scoring (Apple Intelligence on-device)
• Built-in Swift Device Preview gallery of 17 display targets
• OpenClaw Gateway native pairing (self-generated Ed25519 in Keychain)
• Voice input via Apple SFSpeech — no install, fully on-device
• ESP32 Wi-Fi provisioning & Pixoo matrix in-app sheets
• 3-pane first-launch onboarding

Feedback welcome: admin@foundby.kr
```

**iOS App**

```
🎉 AgentDeck — first App Store release (iOS companion)

What's in v1.0.0:
• Mac + iPad/iPhone simultaneous pairing (Bonjour auto + QR fallback)
• Real-time Claude Code + opt-in Codex/OpenClaw session monitoring (relayed from your Mac)
• View APME scores computed on your Mac
• Read-only OpenClaw Gateway status mirror
• Read-only ESP32/Pixoo/Timebox/D200H hardware status mirror

Requires AgentDeck running on a Mac on the same Wi-Fi network.

Feedback welcome: admin@foundby.kr
```

---

## Screenshot Guidance

The upload-ready set is in `apple/appstore-submission/screenshots/`. Do not upload the older raw captures in `apple/appstore-screenshots/`; several are duplicate onboarding frames or non-App-Store desktop captures.

Current upload-ready set: 3 macOS + 3 iPhone + 3 iPad screenshots. The mobile dashboards use deterministic sample sessions and contain no real project names, auth tokens, local IP addresses, or USB paths.

### macOS upload order (2880×1800)

1. **Device Preview** — hardware-optional value proposition with Stream Deck+ selected.
2. **Agent evaluation (APME)** — Foundation Models selected and Apple Intelligence ready.
3. **Integrations** — opt-in Claude/Codex observation and local account status handled by the Swift app.

### iPhone upload order (1284×2778, 6.5-inch)

1. **Welcome** — product value proposition.
2. **Live dashboard** — three privacy-safe sample agents in processing and idle states.
3. **Attention** — a focused permission request from the Swift-daemon dashboard.

### iPad upload order (2064×2752, 13-inch)

1. **Live dashboard** — full session list, topology, aquarium, and timeline.
2. **Attention** — permission state with the selected agent surfaced prominently.
3. **Aquarium view** — HUD-reduced view of the three agent creatures and timeline.

---

## App Privacy (ASC form)

Data collection answers for the App Privacy questionnaire:

| Question | Answer |
|---|---|
| Does your app collect data? | **Yes** — only when the user enables an optional remote evaluation backend and points it at an endpoint they choose |
| Data types collected | Other User Content; Product Interaction |
| Linked to the user | Yes (the user supplies the API credential for the endpoint they configured) |
| Purpose | App Functionality |
| Data used for tracking | None |
| Advertising/marketing use | None |

Backed by:
- No analytics SDKs (no Firebase, no Amplitude, no Segment).
- No crash reporting beyond macOS/iOS system-level (users opt into via Apple, not via us).
- APME scores are stored locally. The default Foundation Models backend is on-device and contacts no network endpoint.
- Remote evaluation backends are opt-in and the user types in the endpoint. When one is selected, the agent turn content required for evaluation and the associated API interaction data are sent to that endpoint for app functionality, and may be linked through the credential the user supplied:
  - **Anthropic API** — turn content goes to Anthropic.
  - **OpenAI-compatible** — turn content goes to whatever OpenAI-compatible server the user configures. This may be a loopback server on their own machine (Ollama, LM Studio, vLLM, llama.cpp), in which case nothing leaves the device, or a remote third-party endpoint such as OpenRouter used with the user's own key, in which case turn content is transmitted to that third party.
  - **MLX local server** — loopback HTTP to a server the user started; nothing leaves the device.
- AgentDeck sends evaluation data to no endpoint of its own; there is no AgentDeck-operated server.
- Voice audio processed on-device.

---

## App Review Notes

Condense `apple/APP_REVIEW_NOTES.md` into the App Store Connect "Review Notes" field — the field caps at 4,000 characters and the full file is ~23,000, so paste the relevant sections, not the whole file. Key points the reviewer will care about:

1. Why we run a local WebSocket server (iPad companion).
2. OpenClaw Gateway-native pairing (self-generated identity, not file read).
3. Zero bundled subprocess — verified by `apple/scripts/verify-appstore-archive.sh` in CI.
4. Claude Code hooks are opt-in via NSOpenPanel.
5. Voice uses Apple on-device SFSpeech (no network, no whisper).

No demo account required — the app doesn't have user accounts.

**macOS review**: reviewer can open "Preview Devices" to see the Swift app's 17 built-in layouts without a real session, then enable only the agent integrations they want to test.

**iOS/iPadOS review**: the iOS app is a companion only — it has no local demo/sample-session mode in the release build (that path is `#if DEBUG`-only, used solely to capture App Store screenshots; see `apple/appstore-submission/RECORDING_RUNBOOK.md`). It shows nothing meaningful until it pairs with a Mac on the same Wi-Fi network running AgentDeck (App Store) or the `agentdeck` CLI with a live Claude Code/Codex session. Since this app record submits macOS and iOS together, ask the reviewer to test both builds on the same network so the iOS app can pair with the macOS build via Bonjour or the in-app QR code (Settings → Pair iPad). If Apple's review environment can't run two devices on one network, offer a short screen-recording link demonstrating the pairing flow and live dashboard as a fallback in the Review Notes field.

---

## Copyright / Support URL

| Field | Value |
|---|---|
| Copyright | `© 2026 Serendipity Bound` |
| Support URL | `https://github.com/puritysb/AgentDeck/issues` |
| Marketing URL | `https://puritysb.github.io/AgentDeck/` |
| Privacy Policy URL | `https://puritysb.github.io/AgentDeck/#privacy` |

Marketing URL은 GitHub Pages 랜딩(2026-07-19 제출 시 실제 입력값). 레포 자체는 Support URL로만 노출한다.

The public policy must disclose every opt-in remote evaluation backend that can carry turn content off the device — Anthropic API and any user-configured OpenAI-compatible endpoint, including remote third parties such as OpenRouter — as well as microphone, speech recognition, local network, user-selected files, USB/Bluetooth hardware access, credentials, and the contact email. When a backend is added to the app, update the policy in `scripts/pages-index.html` in the same commit.
