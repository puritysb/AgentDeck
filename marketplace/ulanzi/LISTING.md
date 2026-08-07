# AgentDeck — Ulanzi Studio Marketplace listing

Submission target: **https://ugc.ulanzistudio.com** → `작품 업로드` (Upload work).
The original **1.0.0** entry #1064 was rejected/removed by Ulanzi support on
2026-07-22. The corrected **1.0.1** form, ZIP, and media were submitted after
the portal's main-file uploader began working later that day. AgentDeck now
appears under `Works under review`, but its generated `/contentView/32` link
displays an unrelated Chinese Profile work, `Douyin Live Studio` v1.0.0. The
content-record mismatch was reported in the original support thread with the
reproduction URL and AgentDeck UUID/category; wait for Ulanzi to confirm the
review entry is linked correctly before treating the submission as healthy.

## 1.0.3 — the setup tutorial lives in the panel, and it is live

Ulanzi's 2026-08-07 message asked for "an H5 setup tutorial added to the
plugin's configuration section so that new users can follow the instructions to
set up their environment and avoid getting stuck on the first step", and invited
a better suggestion. The better suggestion is that a picture of three steps
cannot tell a user *which* step they are stuck on. So the panel is a **live
stepper**: it probes the local daemon and marks each step done or current, which
turns "why are my keys OFFLINE?" into something the panel answers rather than
something the user has to infer.

- **Built on the SDK's own rails**, after reading the reference plugin: the
  inspector loads `libs/js/*` and calls `$UD.connect()`, and every string is a
  `data-localize` key resolved from the `Localization` map in `<language>.json`
  — the same files that localize the action in the palette, and the files your
  translators already know how to edit. Studio therefore owns the language.
  English stays in the markup so the panel is complete even if the socket never
  opens; `.uspi-wrapper` is deliberately not hidden-until-connected, because a
  configuration section that renders nothing is what opened this review.
- **The H5 page itself**: `property-inspector/tutorial.html`, opened from the
  panel with `$UD.openView('./property-inspector/tutorial.html', 900, 780)` —
  the same three steps with room to show macOS and Windows side by side, and the
  same live check. It closes itself with `window.close()`, per the SDK.
- Three illustrated steps — run the daemon, start an agent, fill the keys — with
  the real 5×3 D200H page drawn in step 3 so the payoff is visible before it
  happens. All artwork is inline SVG in the host's own colours; the package
  ships no image assets and the panel needs no network to render.
- **macOS / Windows tabs**, auto-selected from the webview's platform, and one
  click to copy `npx @agentdeck/setup`.
- **English, 简体中文, 繁體中文, 日本語, 한국어** — shipped as `en.json`, `zh_CN.json`,
  `zh_HK.json`, `ja_JP.json`, `ko_KR.json` in the SDK's own layout, covering the
  palette entry and both setup surfaces from one file per language.
- The check now works against **both** daemons. 1.0.2 claimed `/health` was
  readable cross-origin; that is true only of the macOS app's daemon — the Node
  CLI daemon sends no `Access-Control-Allow-Origin`, so the panel's fetch was
  blocked and it reported "no daemon" on exactly the setup Ulanzi tests on
  Windows. Fixed on both sides: the daemon gained a secret-free
  `GET /setup-status` that answers cross-origin (`/health` cannot — it carries
  the pairing token), and the panel falls back to a `no-cors` reachability probe
  for older daemons, which proves step 1 and says plainly that it cannot confirm
  step 2 rather than guessing.

The copy was then audited against the code rather than against intent, which
corrected three claims: the layout spreads over **the keys the user actually
placed** (`positions()` → `buildSessionDeck`), not over the whole page from one
drag; the Mac App Store app needs **macOS 26+** and is not offered on every
storefront, so the terminal path is presented as an equal path rather than a
fallback; and ChatGPT-desktop Codex sessions are picked up **once the Codex hooks
are registered** — automatic on the terminal path, a consent step in the
sandboxed App Store app.

Guarded by `plugin-ulanzi/src/__tests__/property-inspector.test.ts`: the manifest
must name a file that exists, the SDK libraries and the H5 page must be present
and referenced, every `data-localize` key and runtime lookup must resolve in
every shipped language, each language must stay key-aligned with English, every
localizable element must carry English text (so an unreachable Studio costs the
translation and nothing else), the `{port}` placeholder must survive
translation, and neither surface may read `pairingToken`.

## 1.0.2 — Property Inspector (the actual fix for the review feedback)

The tester screenshot attached to Ulanzi's 2026-08-05 message showed the real
shape of the problem, and it was not an empty deck: the bottom row already
rendered live session tiles (`IDLE / AgentDeck / opus-4.8`), so that machine had
a daemon and a Claude session. The six keys above showed Ulanzi Studio's own
placeholder — **"Setup … Click for guide"**, which is not our string — and
clicking it opened nothing.

Cause: the action declared no `PropertyInspectorPath`. Every plugin in the SDK
examples declares one; without it Studio has no panel to open. That is literally
"there are no instructions provided".

So 1.0.2 adds `property-inspector/inspector.html`: getting-started steps for both
daemons plus a live check against `/health` (which the panel could only read on
the macOS app's daemon — see 1.0.3 above for the CORS correction). It borrows the host's `uspi.css` so
it reads as part of Studio rather than painting our palette — that vendored file
is lint-excluded the same way the Stream Deck plugin's `sdpi-components.js` is.

`scripts/package-ulanzi-plugin.sh` now copies `property-inspector/` and `libs/`
**and fails the build** when the manifest names an inspector the archive does not
contain — shipping a manifest that points at a missing file would be worse than
shipping none.

## Getting-started guide (requested by Ulanzi review, 2026-08-05)

Ulanzi's internal testers reported that dragging the action onto a key left them
with nothing to follow, and asked for a guide. The plugin is a thin client, so an
empty deck is the correct rendering until a daemon runs — but nothing on the key
can say so in full: the OFFLINE hero's hint line truncates at 22 characters
(`shared/src/svg-renderers/session-slot-renderer.ts`), which fits
`npx @agentdeck/setup` and nothing more. The answer is therefore a document, not
key copy: **[GETTING-STARTED.md](GETTING-STARTED.md)**.

It covers both daemons now that the Mac App Store app has shipped — the app for
a no-terminal macOS install, `npx @agentdeck/setup` for macOS/Windows — and
states the one capability that differs (Claude 5h/7d quota is relay-only in the
sandboxed app). Send that page when answering the review thread.

## Upload-form requirements

Read off the portal's own form, not from documentation — Ulanzi publishes no
asset spec. Two things the form does NOT tell you up front are recorded below.

| Slot | Required | Ratio | Our file |
|---|---|---|---|
| Main file | yes | — (`.zip`, ≤50 MB/file) | `dist/com.ulanzi.ulanzistudio.agentdeck.ulanziPlugin.zip` (9.5 MB) |
| Cover image | yes | **1:1 for plugins** | `marketplace/ulanzi/1.0.1/cover-1024x1024.jpg` |
| Banner 01 | yes | 3:2 | `marketplace/ulanzi/1.0.1/banner-01-1920x1280.jpg` |
| Banner 02 | optional | 3:2 | `marketplace/ulanzi/1.0.1/banner-02-1920x1280.jpg` |
| Banner 03 | optional | 3:2 | `marketplace/ulanzi/1.0.1/banner-03-1920x1280.jpg` |

Regenerate with `node scripts/generate-ulanzi-marketplace-assets.mjs`.

### Gotcha 1 — the cover ratio is conditional

The form shows `2:1` until the main file is uploaded and recognised as a plugin,
then flips to `1:1`: "플러그인 커버는 UlanziStudio MarketPlace용으로 1:1 비율을
사용합니다." **Upload the zip first, then read the cover requirement.** Only the
1:1 file is generated; there is no 2:1 variant to pick up by mistake.

### Gotcha 2 — ZIP basename must match the root folder

The current portal validates that the ZIP basename (without `.zip`) exactly
matches the single top-level folder. Therefore the upload artifact must be
`com.ulanzi.ulanzistudio.agentdeck.ulanziPlugin.zip`, containing
`com.ulanzi.ulanzistudio.agentdeck.ulanziPlugin/` at its root. A versioned ZIP
filename is rejected even when its internal plugin structure is otherwise
valid.

If no cover is supplied the portal auto-fills one from the plugin's own
`resources/icons/plugin.png`, so an empty-looking slot is not actually empty.

### Gotcha 3 — upload assets ONE AT A TIME

Every image upload opens an 이미지 자르기 (crop) dialog, and the file is only sent
to the server when you press 확인 in that dialog. Queue four uploads back to back
and the crop dialogs stack: the ones you never confirm stay as **local `data:`
previews**. The slot renders a perfectly normal thumbnail either way, so there is
no visual difference between "saved" and "not saved" — the submit just fails.

Verify by checking that each thumbnail's `src` is a `/cdn/uploadPath/...` URL and
not a `data:` URI. A thumbnail is not evidence of an upload.

### Publishing is a MANUAL, email-gated step — my uploads is not the store

Ulanzi support (2026-07-20), on how an upload reaches the Marketplace:

> 업로드하신 콘텐츠를 Marketplace에 추가하려면 반드시 고객 지원팀에 문의해 주세요.
> 공식 이메일 주소(ustudioservice@ulanzi.com)로 [업로드한 파일 ID 또는 이름 / 공유를
> 원하는 이유 및 사용 사례]를 보내주시면 담당 팀에서 검토 후 반영합니다.
> 추후 Marketplace에 사용자 생성 콘텐츠를 직접 게시할 수 있는 기능이 추가될 예정입니다.

So there is **no automatic review pipeline**. Uploading through 작품 업로드 only
parks the entry in your own my-uploads list; a human at Ulanzi publishes it after
you email them. `status: 0` means "sitting in my uploads", NOT "queued for
review" — an earlier revision of this file read it as a queue position and
recommended waiting on that basis. That was wrong.

### Known blocker — 작품 업데이트 returns 404 (Ulanzi-side, 2026-07-20)

Editing an existing upload fails. The bundle's API map splits the update call
and the backend serves only one side:

| Action | Endpoint | Backend |
|---|---|---|
| edit (normal) | `/api/updateResources` | 200 |
| **edit (audit)** | `/api/updateAuditResources` | **404** |
| delete (normal) | `/api/removeResources` | 200 |
| **delete (audit)** | `/api/removeAuditResources` | **404** |
| register | `/api/saveResources` | 200 |

Our entry takes the audit branch, so it can be neither edited NOR deleted — the
delete button's confirm dialog appears but no request ever leaves. The whole
`*AuditResources` family is absent from the deployed backend, which reads as the
audit feature never having shipped server-side while the frontend still routes to
it. Consistent with user uploads never entering a real audit flow.

Evidence it is theirs, not ours: a pristine reload with zero edits still 404s;
the JS bundle is current (`index-7TL9tKSN.js` matches a fresh fetch); every
sibling route answers (`userInfo`, `myList`, `cateList`, `dictData`, `upload`,
`saveResources`, `updateResources`); the record itself is fine.

**There is no self-service workaround.** Delete-and-re-upload was the obvious
escape and it does not work either: deletion takes the same broken branch. The
entry is frozen with its first-draft media until Ulanzi removes it, so the only
path is the mail in `SUBMISSION_EMAIL.md`, which asks them to delete #1064 so the
final assets can be uploaded fresh. Registration (`saveResources`) does work, so
re-uploading is fine once the old entry is gone.

Do NOT hand-craft a POST to `updateResources` or `removeResources` to force it:
the payload contract is unverified and it would be writing to a live account.

### Gotcha 2 — the 1000-character cap truncates silently

`상세 소개` is capped at 1000 characters and the form **cuts the overflow without
warning**. On the 2026-07-20 pass the German (1169), Portuguese (1087) and
Spanish (1146) descriptions were all silently clipped mid-sentence, losing the
trademark disclaimer. The only visible symptom was a counter reading exactly
`1000 / 1000`. Measure every locale before pasting.

## Field limits

`이름` 40 · `요약` 1000 · `상세 소개` 1000 characters, per language.
All seven language tabs are required — an empty tab blocks submission.

## Metadata (as submitted)

- **유형 (Type)**: `插件` (plugin)
- **버전 번호**: `1.0.0`
- **카테고리**: `工具` — the five options are 直播 / 创作 / 灯光 / 办公 / 工具; there is no developer or monitoring category, so 工具 is the closest fit
- **고유 ID**: `com.ulanzi.ulanzistudio.agentdeck`
- **추가 링크**: `https://puritysb.github.io/AgentDeck/`

## Compatibility (as submitted)

- **지원 언어**: all seven — 中文 / English / Deutsch / 日本語 / 한국어 / Português / Español. The field controls "프론트엔드 표시 범위와 필터 태그", i.e. which localized listings surface, so it tracks the copy below rather than the plugin's UI language (the plugin ships only `en.json`).
- **지원 장치**: **D200H only.** The form pre-selects D200, D200H, D200X and Dial; `manifest.json` declares `Devices: ["D200H"]` and no code path handles the others, so the other three are deselected.
- **지원 시스템**: Windows · macOS (Apple Silicon) · macOS (Intel). Verified against the shipped archive, which carries `resvgjs.darwin-arm64`, `darwin-x64`, `win32-x64`, `win32-arm64` and `win32-ia32` binaries. Note the manifest's own floor (mac 10.11 / Windows 10) is optimistic — the plugin would load but find no daemon; the real floor is the daemon's, macOS 15 / Windows 11.

---

## English

### Name

```
AgentDeck
```

### Summary

```
Turn the D200H into a live control surface for AI coding agents. Session keys reflow by agent state — Claude Code, Codex, OpenCode, and OpenClaw activity, attention, prompt choices, modes, stop controls, and usage, all on your deck.
```

### Description

```
Stop Chatting. Start Steering.

AgentDeck brings your AI coding agents out of the terminal and onto the D200H. The plugin ships one dynamic action — fill your keys with it and each key reflows on its own as work happens.

Features
• Live session keys for Claude Code, Codex, OpenCode, and OpenClaw
• Distinct attention state — see which agent is waiting on you
• Prompt steering, mode toggle, and stop from the key
• Token and quota gauges with reset countdowns
• Automatic reconnect and an explicit OFFLINE state

Getting set up
A thin client — it needs the free AgentDeck daemon on the same computer. On macOS, use the free AgentDeck app from the Mac App Store (no terminal needed). On macOS or Windows, you can instead run:

    npx @agentdeck/setup

That is the whole setup.

The plugin bundles no daemon, touches no USB HID, and collects no analytics.

AgentDeck is an independent project, not affiliated with any third party mentioned. All trademarks belong to their owners.
```

---

## 한국어

### Name

```
AgentDeck
```

### Summary

```
D200H를 AI 코딩 에이전트 조종석으로. 키가 에이전트 상태에 따라 스스로 재배치됩니다 — Claude Code, Codex, OpenCode, OpenClaw의 진행 상태·응답 대기·프롬프트 선택·모드·중단·사용량을 데크 위에서 바로.
```

### Description

```
AgentDeck은 AI 코딩 에이전트를 터미널 밖 D200H 위로 꺼내 놓습니다.

대화 말고 조종하세요.

플러그인이 제공하는 동적 액션은 하나입니다. 키를 이걸로 채워 두면 작업이 진행되는 대로 각 키가 알아서 바뀝니다 — 실행 중인 세션, 답을 기다리는 에이전트, 고를 프롬프트 선택지, 모드 전환, 중단 버튼, 사용량 게이지.

주요 기능
• Claude Code, Codex, OpenCode, OpenClaw 실시간 세션 키
• 응답 대기 상태를 별도 표시 — 어떤 에이전트가 기다리는지 한눈에
• 프롬프트 조종 — 키에서 바로 선택지 고르기
• 포커스된 세션의 모드 전환 및 중단
• 토큰·쿼터 게이지와 리셋 카운트다운
• 자동 재연결 및 명시적 OFFLINE 상태 표시

설치 방법
얇은 클라이언트라 같은 컴퓨터에서 무료 AgentDeck 데몬이 실행 중이어야 합니다. macOS에서는 무료 Mac App Store 앱을 사용하면 터미널이 필요 없습니다. macOS 또는 Windows의 터미널에서는 다음을 실행할 수도 있습니다.

    npx @agentdeck/setup

이게 전부입니다.

플러그인은 데몬을 내장하지 않으며, USB HID에 직접 접근하거나 분석 데이터를 수집하지 않습니다.

AgentDeck은 독립적인 프로젝트이며 언급된 어떤 제3자와도 제휴 관계가 없습니다. 모든 상표는 각 소유자의 자산입니다.
```

---

## 日本語

### Name

```
AgentDeck
```

### Summary

```
D200HをAIコーディングエージェントの操縦席に。キーはエージェントの状態に応じて自動で組み替わります — Claude Code、Codex、OpenCode、OpenClawの進行状況・応答待ち・プロンプト選択・モード・停止・使用量をデッキ上で。
```

### Description

```
AgentDeckは、AIコーディングエージェントをターミナルの外、D200Hの上に引き出します。

会話ではなく、操縦を。

このプラグインが提供する動的アクションは1つだけです。キーをこれで埋めておけば、作業の進行に合わせて各キーが自動で切り替わります — 実行中のセッション、応答を待っているエージェント、選ぶべきプロンプトの選択肢、モード切替、停止ボタン、使用量ゲージ。

主な機能
• Claude Code、Codex、OpenCode、OpenClawのリアルタイムセッションキー
• 応答待ち状態を個別に表示 — どのエージェントが待っているか一目で
• プロンプト操作 — キーから直接選択肢を選ぶ
• フォーカス中セッションのモード切替と中断
• トークン・クォータゲージとリセットまでのカウントダウン
• 自動再接続と明示的なOFFLINE表示

セットアップ
シンクライアントのため、同じコンピュータ上で無料のAgentDeckデーモンが動作している必要があります。macOSでは、Mac App Storeの無料AgentDeckアプリを使えばターミナルは不要です。macOSまたはWindowsのターミナルでは、次を実行することもできます。

    npx @agentdeck/setup

これだけです。

プラグインはデーモンを同梱せず、USB HIDへの直接アクセスや解析データの収集も行いません。

AgentDeckは独立したプロジェクトであり、言及されたいかなる第三者とも提携関係はありません。すべての商標は各所有者に帰属します。
```

---

## 中文（简体）

### Name

```
AgentDeck
```

### Summary

```
把 D200H 变成 AI 编程助手的实时控制台。按键会随助手状态自动重排 —— Claude Code、Codex、OpenCode、OpenClaw 的运行状态、待回复提醒、提示选项、模式、停止和用量，全部呈现在你的 Deck 上。
```

### Description

```
别只是聊天，直接操控。

AgentDeck 把 AI 编程助手从终端里搬到 D200H 上。插件只提供一个动态动作 —— 用它铺满按键，每个键都会随着工作进展自动切换。

主要功能
• Claude Code、Codex、OpenCode、OpenClaw 的实时会话按键
• 单独标示待回复状态 —— 一眼看出哪个助手在等你
• 直接在按键上选择提示选项、切换模式、中断任务
• 令牌与配额仪表，并显示重置倒计时
• 自动重连，未连接时显示明确的 OFFLINE 状态

安装方法
本插件是瘦客户端，需要在同一台电脑上运行免费的 AgentDeck 守护进程。在 macOS 上，可使用 Mac App Store 中的免费 AgentDeck 应用，无需终端；也可在 macOS 或 Windows 的终端中运行：

    npx @agentdeck/setup

这样就完成了。

本插件不内置守护进程，不直接访问 USB HID，也不收集任何分析数据。

AgentDeck 是独立项目，与文中提及的任何第三方均无从属关系。所有商标归各自所有者所有。
```

---

## Deutsch

### Name

```
AgentDeck
```

### Summary

```
Machen Sie das D200H zur Steuerzentrale für KI-Coding-Agents. Die Tasten ordnen sich je nach Agent-Status neu an — Aktivität, Wartezustände, Prompt-Optionen, Modi, Stopp und Verbrauch von Claude Code, Codex, OpenCode und OpenClaw, direkt auf Ihrem Deck.
```

### Description

```
Schluss mit Chatten. Steuern Sie.

AgentDeck bringt Ihre KI-Coding-Agents aus dem Terminal auf das D200H. Belegen Sie die Tasten mit der dynamischen Aktion; sie passen sich dem Arbeitsstatus automatisch an.

Funktionen
• Live-Tasten für Claude Code, Codex, OpenCode und OpenClaw
• Klarer Wartezustand für Agents, die Ihre Antwort brauchen
• Prompt-Auswahl, Moduswechsel und Stopp auf der Taste
• Token- und Kontingentanzeigen mit Countdown
• Automatische Neuverbindung und klarer OFFLINE-Zustand

Einrichtung
Der Thin Client benötigt den kostenlosen AgentDeck-Daemon auf demselben Computer. Unter macOS gibt es die kostenlose Mac-App ohne Terminal. Unter macOS oder Windows können Sie alternativ ausführen:

    npx @agentdeck/setup

Mehr ist nicht nötig.

Das Plugin enthält keinen Daemon, greift nicht direkt auf USB HID zu und sammelt keine Analysedaten.

AgentDeck ist ein unabhängiges Projekt ohne Verbindung zu den genannten Dritten. Marken gehören ihren Inhabern.
```

---

## Português

### Name

```
AgentDeck
```

### Summary

```
Transforme o D200H em um painel de controle ao vivo para agentes de programação com IA. As teclas se reorganizam conforme o estado do agente — atividade, espera por resposta, opções de prompt, modos, parada e uso do Claude Code, Codex, OpenCode e OpenClaw, tudo no seu deck.
```

### Description

```
Pare de conversar. Comece a pilotar.

O AgentDeck leva seus agentes de programação com IA do terminal ao D200H. Preencha as teclas com a ação dinâmica; elas se adaptam automaticamente ao estado do trabalho.

Recursos
• Teclas ao vivo para Claude Code, Codex, OpenCode e OpenClaw
• Destaque para o agente que aguarda sua resposta
• Escolha de prompt, modo e parada direto da tecla
• Medidores de tokens e cota com contagem regressiva
• Reconexão automática e estado OFFLINE claro

Instalação
O cliente leve precisa do daemon gratuito no mesmo computador. No macOS, use o app gratuito da Mac App Store sem terminal. No macOS ou Windows, também pode executar:

    npx @agentdeck/setup

É só isso.

O plugin não inclui daemon, não acessa USB HID diretamente e não coleta dados de análise.

O AgentDeck é um projeto independente, sem afiliação com terceiros mencionados. As marcas pertencem aos seus proprietários.
```

---

## Español

### Name

```
AgentDeck
```

### Summary

```
Convierte el D200H en un panel de control en vivo para agentes de programación con IA. Las teclas se reorganizan según el estado del agente: actividad, espera de respuesta, opciones de prompt, modos, parada y uso de Claude Code, Codex, OpenCode y OpenClaw, todo en tu deck.
```

### Description

```
Deja de conversar. Empieza a pilotar.

AgentDeck lleva tus agentes de programación con IA de la terminal al D200H. Llena las teclas con la acción dinámica y se adaptarán automáticamente al estado del trabajo.

Funciones
• Teclas en vivo para Claude Code, Codex, OpenCode y OpenClaw
• Estado claro para el agente que espera tu respuesta
• Elección de prompt, modo y parada desde la tecla
• Medidores de tokens y cuota con cuenta atrás
• Reconexión automática y estado OFFLINE claro

Instalación
El cliente ligero necesita el daemon gratuito en el mismo equipo. En macOS, usa la app gratuita de la Mac App Store sin terminal. En macOS o Windows, también puedes ejecutar:

    npx @agentdeck/setup

Eso es todo.

El plugin no incluye daemon, no accede directamente a USB HID y no recopila datos de análisis.

AgentDeck es un proyecto independiente, sin afiliación con los terceros mencionados. Las marcas pertenecen a sus propietarios.
```

---

## Gallery sources

Nothing is upscaled. The deck face is not screenshotted at all — it is rendered
from the canonical `buildSessionDeck` slots, which are viewBox SVG and therefore
rasterise crisp at any size (DESIGN.md R7). That replaced the previous
`d200h-app.png` composite, a 964×590 capture drawn at 1020px — a 1.06× upscale
that also filled only 53% of the 1920 canvas, making it the soft one in the
carousel.

| File | Source |
|---|---|
| `cover-1024x1024.jpg` | Accurate D200H 5 + 5 + 3 + clock shell with `buildSessionDeck` @132px/key + `design/brand/agentdeck-icon.png` + the four upstream agent marks |
| `banner-01-1920x1280.jpg` | Accurate D200H shell with `buildSessionDeck` @250px/key |
| `banner-02-1920x1280.jpg` | `docs/media/d200h-hero.jpg` 4032×3024, framed on the whole deck (0.53× downscale) |
| `banner-03-1920x1280.jpg` | `docs/media/macos-dashboard.png` 2362×1430, timeline pane cropped (0.71× downscale) |

Photographic imagery is deliberately D200H-only. Desk shots that also contain an
Elgato Stream Deck were tried and rejected — a competitor's device reading as the
most legible thing in frame does not belong on Ulanzi's own storefront.

**banner-03 privacy note.** The macOS capture's bottom quarter is the live
timeline, and at storefront size its rows are legible real project chatter. The
generator crops above the timeline and fades the cut, so the banner carries only
the terrarium, session list, and quota gauges. Do not re-crop it taller.

## Release notes (v1.0.1)

First public Marketplace candidate for the D200H, synchronized to AgentDeck
1.0.1. Dynamic session keys, multi-agent state and attention rendering, prompt
steering, stop and mode controls, usage views, reconnect behavior, and correct
host display sleep/wake handling through the official Ulanzi Studio runtime.

## Submission files

- Installable folder: `plugin-ulanzi/dist/com.ulanzi.ulanzistudio.agentdeck.ulanziPlugin/`
- Upload archive: `dist/com.ulanzi.ulanzistudio.agentdeck.ulanziPlugin.zip`
- Verification guide: `plugin-ulanzi/VERIFY.md`
