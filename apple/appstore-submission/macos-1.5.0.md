# Apple 1.5.0 store submission

Status (2026-09-23): macOS and iOS **1.5.0 (7301)** are submitted for review with automatic release after approval. Both portals report Waiting for Review. Build artifacts came from [Apple release run 35805428128](https://github.com/puritysb/AgentDeck/actions/runs/35805428128), commit `4c8a5d2cfe17921171a0abd36e0ced8b70acf237`. Neither version is yet claimed live.

- [macOS review receipt](https://appstoreconnect.apple.com/apps/6784822497/distribution/reviewsubmissions/details/b3c5da04-443f-4562-9873-3e5c48219104)
- [iOS review receipt](https://appstoreconnect.apple.com/apps/6784822497/distribution/reviewsubmissions/details/ed244930-0283-4129-acb4-b958b9c5a7ab)

English promotional copy and descriptions now explain the optional 3D aquarium. English, Korean and Japanese release notes were saved for both platforms. The macOS English preview was replaced with a fresh aquarium capture followed by Collaboration and settings; existing localized and iOS media remain. Review notes explain bundled assets, retained preferences and the iOS 18 requirement.

Validation: Release archive and submission-package gates passed. The refreshed video is 1920×1080, 30 fps, H.264 High level 4.0 with AAC, 28.7 seconds and an average bitrate of **10,935,065 bps**. An initial 8.46 Mbps encode failed the local 10–12 Mbps target; it was re-encoded and the complete validator passed before replacing the portal preview and resubmitting the unchanged 7301 build.

Copy-ready localized fields: [macOS metadata](macos-1.5.0-metadata.json) and [iOS metadata](ios-1.5.0-metadata.json). The sections below retain the preparation history; the dated status above is the current delivery state.

## Scope

The requested scope now includes macOS and iOS. The shared Apple source marketing version is 1.5.0. Use the manual Apple Release workflow with platform `all`. The familiar dashboard remains the default. The new layout is explicitly labeled **3D aquarium · Preview** in Settings → Dashboard.

## What’s New — English

Choose a new 3D aquarium in Dashboard settings. Your agent sessions appear as familiar characters in a planted underwater habitat, with lively working animations, reactive schools of fish, and a small wandering snail. Session status, usage and timeline information remain visible, and you can return to the default dashboard at any time. Includes improved GLM usage display on connected iDotMatrix devices.

## What’s New — Korean

대시보드 설정에서 새로운 3D 수족관을 선택할 수 있습니다. 익숙한 에이전트 캐릭터들이 수초와 바위가 있는 수중 환경에서 작업하며, 물고기 떼와 작은 달팽이가 움직입니다. 세션 상태, 사용량, 타임라인을 함께 확인하고 언제든 기본 대시보드로 돌아갈 수 있습니다. 연결된 iDotMatrix 기기의 GLM 사용량 표시도 개선했습니다.

## What’s New — Japanese

ダッシュボード設定で新しい3D水族館を選べるようになりました。おなじみのエージェントキャラクターが水草や岩のある水中空間で作業し、魚の群れや小さなカタツムリが動きます。セッションの状態、使用量、タイムラインを引き続き確認でき、いつでも標準のダッシュボードに戻せます。接続したiDotMatrixのGLM使用量表示も改善しました。

## Reviewer supplement

The optional layout is available in Settings → Dashboard → Dashboard type → 3D aquarium · Preview. All scene assets are bundled; there are no model downloads, external renderers, or new permissions. The app continues to use its native in-process daemon and existing integrations. The familiar dashboard remains available. The preview video uses synthetic demonstration sessions; these are capture data, not a bundled set of live user sessions. Existing review setup instructions remain in APP_REVIEW_NOTES.md.

## Recording

The video is a real macOS app window capture using the deterministic local demo feed, without real workspace names or conversations. Encode the store preview at 1920×1080, 30 fps, H.264 High level 4.0, 10–12 Mbps, with a silent AAC track. The updated 28.7-second cut includes 13.2 seconds of aquarium, 12.8 seconds of Collaboration (current task followed by a selected earlier task and its summary), and 2.7 seconds of Dashboard settings. Keep the unedited capture locally for provenance. Verify the final file with the submission validator before upload.

## Initial crowd review — historical finding

A synthetic runtime probe supplied 20 threads across 12 independent workspaces. Nine Codex CLI threads in Workspace 02 folded into one `×9` creature; the full session list retained the individual entries. The resulting 12-creature scene shrank its labels and placed its top row behind the attention panel. Existing 12/24/48-slot geometry tests cover creature-to-creature clearance, not HUD occlusion or readable text size.

The initial follow-up called for refining the crowded layout and visually checking 10, 20 and 40 independent sessions plus parent/child bursts. Preserve independent session identity. Treat explicit parent/child relationships separately from the existing provider/project fold: matching project names alone is not proof of parentage. Keep selection and attention visible, retain stable positions, and avoid silently hiding a waiting child inside an active group. The 3D projection currently shows the available helper count as text; it does not implement a general interactive family-group UI.

Suggested direction: a readable foreground group for selected/attention sessions, quieter rear placement for other independent sessions, and an expandable parent group with helper count and aggregate status. Density reduction must not eliminate any session from the roster or lose its focus target. Do not claim this proposed behavior is already implemented.

## Collaboration review

Improved the existing opt-in lens with actionable session choices before selection and confirmed peer shortcuts near the parent. Input requests sort first; peer status comes from the current roster, separately from historical relation phases. The view does not create teams from shared projects or claim to orchestrate agents. Task titles are kept separate from result summaries. Navigation to a peer and back was verified in the native app with synthetic data.

Initial targeted XCTest: 15 passed; the existing offscreen `testRenderCollaborationHistoryAtRailWidth` failed with the previously documented macOS `InvalidTransition` error. Real-window rendering was checked instead; the failing test is not reported as passing. Full TypeScript checks passed (4,671 tests, 2 skipped). At that stage, store submission remained pending crowded-aquarium refinement and Release archive checks.

## Collaboration strengthening and default-layout decision

Added a picker for the latest eight tasks, retaining an explicit historical selection across polling. A missing or wrong-session record never substitutes another task. Task summaries are shown independently of titles. The four large live census cards now live in a collapsed detail section; repeated explanatory text is consolidated. The final targeted run passes 17 tests with the known offscreen renderer test explicitly excluded (its earlier failure remains documented).

Default-layout recommendation: offer 3D as the first experience for verified new macOS installs only after crowd/HUD, Reduce Motion, fallback and performance acceptance. Existing saved choices must win. Existing users without the new dashboard key must retain the classic view. Onboarding completion alone cannot identify every existing user: it may be skipped, incomplete, or from a version predating that flag. When installation history is ambiguous, preserve the classic view and let the user opt in. Rename the legacy option from “Default” to “Classic” only when the new default is actually introduced. No preference migration or default change is implemented in this preparation; the current default remains standard.

## Mobile release expansion

The user authorized iOS and Android tablet store delivery. iOS shares the native RealityKit assets and controller with macOS; Android now imports the same original character source as individual glTF templates. Existing dashboard preferences are retained, and e-ink does not switch to the native 3D renderer. No ESP32, deck plugin, or matrix firmware deployment is required for these app UI changes.

The native foreground is bounded by the generated shared budget of eight residents, with selected/awaiting/working priority and the full roster retained. The scene reserves space for the visible timeline and attention panel on Apple; aquarium viewing also hides the timeline. This is foreground selection, not a new parent/child grouping or inferred collaboration feature. Device and archive verification remain required before submission.
