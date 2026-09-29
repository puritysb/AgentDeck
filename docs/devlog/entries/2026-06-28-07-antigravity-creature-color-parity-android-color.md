# 2026-06-28 — Antigravity creature color parity: Android color e-ink/tablet + ESP32 terrarium

### 문제
Antigravity 크리처가 Android color e-ink 기기에서 배경과 겹치는 흐릿한 단색처럼 보였고, Android tablet 에서는 원본 rainbow mark 대신 노란색이 과하게 지배적으로 보였다. 또한 TC001 matrix 경로에는 micro sprite 가 있었지만 일반 ESP32 terrarium 경로에는 antigravity session count/name/render 연결이 없어 화면에 나오지 않았다.

### 해결
- Android tablet `AntigravityCreature` 를 canonical path fill rule(`EvenOdd`)로 맞추고, base gradient 를 녹색→시안→블루→핑크→레드→오렌지→노랑 대각 rainbow 로 재조정했다. 기존 warm overlay 는 낮은 alpha 로 줄여 노란색 단색처럼 덮이지 않게 했다.
- Android e-ink renderer 의 color e-ink 모드에서 antigravity mark 를 더 크게 그리고, 어두운 외곽선 + 밝은 hairline 을 추가해 Kaleido 배경 위에서도 형태가 분리되게 했다. 흑백 e-ink 는 기존 고대비 gray fallback 을 유지한다.
- ESP32 terrarium 에 `MAX_ANTIGRAVITY`, `antigravityCount`, `antigravityNames`, `Antigravity::render` 경로를 추가했다. 기존 generated `ANTIGRAVITY_A8` mask 를 정적 참조하고 per-pixel rainbow tint 를 입히므로 render path 에 heap allocation 은 추가하지 않았다. TC001 `led8x32` matrix 경로는 기존 micro sprite 를 유지한다.

### 검증
- Android `./gradlew :app:compileDebugKotlin --no-daemon` 성공.
- Android `./gradlew :app:testDebugUnitTest --tests dev.agentdeck.state.TimelineStoreTest --no-daemon` 성공.
- ESP32 `pio run -d esp32 -e ttgo`, `pio run -d esp32 -e ips35`, `pio run -d esp32 -e led8x32` 성공.
