# 2026-04-08 — D200H Text Bake Experiment: Session-Mode ShowTitle Toggle + PNG Text Overlay

### 문제
Stream Deck와 D200H 사이의 가장 큰 시각 차이는 여전히 텍스트 레이어였다.

- Stream Deck는 세션 버튼 하나의 캔버스 안에 `project / model / state`를 모두 그린다.
- D200H Swift 경로는 펌웨어 안전성을 우선해 PNG는 icon-only로 유지하고, 텍스트는 native label에 맡기고 있었다.

이 구조는 안정적이지만, 버튼 레이아웃이 Stream Deck와 다르게 느껴지는 핵심 원인이었다.

### 해결
- `apple/AgentDeck/App/AppPreferences.swift`
  - `d200hBakeSessionText`
  - `d200hHideNativeSessionLabels`
  - 두 실험 설정을 추가하고 기본값을 `true`로 둬, 현재 사용 환경에서는 바로 Stream Deck parity 시도를 하도록 함
- `apple/AgentDeck/UI/Settings/SettingsScreen.swift`
  - D200H Helper 섹션에 위 두 옵션을 노출
  - 세션 PNG에 텍스트를 굽는 실험과 session-mode `ShowTitle: 0` 동작을 앱에서 바로 제어 가능하게 함
- `apple/AgentDeck/Daemon/Modules/D200hHidModule.swift`
  - label style packet을 고정 `ShowTitle: 1`에서 벗어나 **현재 모드별 동적 제어**로 변경
    - `sessionList` + 실험 on: `ShowTitle: 0`
    - `optionSelect`: `ShowTitle: 1`
  - 따라서 세션 그리드에서는 native label을 숨기고, 옵션 화면에서는 다시 켜서 기존 조작성을 유지
  - session tile에 `textOverlay: .sessionTile`을 추가해 PNG 안에:
    - project name
    - model name
    - `● STATE`
    를 직접 렌더
  - usage merged button도 session mode에서 native label을 끄는 경우 숫자를 잃지 않도록 `.usageStat` overlay를 추가
  - full-render 캐시 키를 `title`만 보던 구조에서 `model/state/overlay/border`까지 포함하도록 넓혀, text-bake 경로에서 상태 변화가 누락되지 않게 함

### 검증
- `xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS' -derivedDataPath /tmp/AgentDeckDerivedDataD200HTextBake build CODE_SIGNING_ALLOWED=NO`
  - 최종 `BUILD SUCCEEDED`

### 핵심 판단
- 이제 Swift 앱은 **세션 모드에 한해** Stream Deck와 훨씬 더 유사한 “single-canvas session button” 실험을 직접 수행할 수 있다.
- 다만 이건 아직 **firmware acceptance 실험 단계**다.
  - 코드상/빌드상으로는 성립했지만
  - 실제 D200H stock firmware가 이 richer PNG를 안정적으로 계속 받아줄지는 실기기 확인이 필요하다
- 만약 이 경로가 실기기에서 안정적으로 먹히면, `완전 동일 UI`에 가장 가까운 stock-firmware 경로가 열린다.
- 반대로 여기서 화면 복귀/무시가 다시 나타나면, 그때는 vendor payload semantics를 더 맞추거나 takeover로 넘어갈 근거가 훨씬 선명해진다.

---
