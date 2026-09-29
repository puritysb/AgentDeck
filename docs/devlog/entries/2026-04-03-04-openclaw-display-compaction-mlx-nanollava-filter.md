# 2026-04-03 — OpenClaw Display Compaction + MLX nanoLLaVA Filter

### 문제
- OpenClaw 모델 목록이 raw 카탈로그 이름을 거의 그대로 보여줘서 `DeepSeek: DeepSeek V3.2` 같은 중복 접두사가 그대로 보였다.
- 모델 family를 묶더라도 `GLM:` 같은 그룹 라벨을 별도로 붙이는 방식은 오히려 UI를 지저분하게 만들 수 있었다.
- MLX probe는 현재 서버가 노출하는 모든 모델을 그대로 보여줘 `nanoLLaVA` 같은 보조 비전 모델까지 Dashboard에 올라왔다.

### 해결
- `TankStatusPanel.swift` / Android `EnginePanel.kt`
  - OpenClaw 모델명을 family 기준으로 compact display 하도록 조정
  - 별도 그룹 라벨은 붙이지 않고 `GLM-5.1, 5 Turbo, 5, 4.7`처럼 접두사를 한 번만 보이게 압축
  - `DeepSeek: DeepSeek ...` 같은 중복 접두사는 정규화
  - OpenClaw 첫 줄(대표 모델이 우선 정렬되는 줄)은 약간 다른 색상으로 강조
- `DaemonServer.swift` / `bridge/src/mlx-probe.ts`
  - MLX model probe 결과에서 `nanoLLaVA`는 기본 Dashboard 목록에서 제외

### 검증
- `xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS' -derivedDataPath /tmp/AgentDeckDerivedDataOpenClawGrouping build CODE_SIGNING_ALLOWED=NO`
- 결과: `BUILD SUCCEEDED`
