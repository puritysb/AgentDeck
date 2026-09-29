# 2026-04-03 — Android E-ink Terrarium Multi-Agent Consistency Fix

### 문제
CremaS에서 ADB를 수동 활성화한 뒤에도 terrarium 표시가 세션 목록과 일치하지 않았다. 상단에는 `OpenClaw`, `Codex CLI`, `OpenCode`, 일반 coding agent 세션이 보이는데, 수조에는 일부 생물만 보이거나 idle 생물들이 한 지점에 겹쳐 보였다. 또한 저장된 WiFi URL이 있으면 USB `adb reverse`보다 먼저 그 주소로 재접속을 시도해, USB 연결을 켠 직후에도 경로가 일관되지 않았다.

### 해결
- `android/.../EinkRenderer.kt`
  - `drawEinkCloud()`와 `drawEinkOpenCode()`가 idle/sleep 상태에서 전달받은 레이아웃 슬롯을 무시하고 고정 Y 좌표로 내려앉던 문제를 수정
  - 모든 상태에서 `centerXFraction` / `centerYFraction` 기반으로 배치하고, 상태별로는 작은 bob 애니메이션만 더하도록 변경
- `android/.../MainActivity.kt`
- `android/.../ui/screen/EinkMonitorScreen.kt`
  - 자동 연결 순서를 `saved URL → localhost → mDNS`에서 `localhost → saved URL → mDNS`로 변경
  - CremaS처럼 USB `adb reverse`가 가능한 기기에서 저장된 WiFi URL 때문에 경로가 흔들리지 않도록 정렬
- `android/.../state/AgentState.kt`
  - daemon/openclaw aggregate 상태에서 relayed child session `state_update`가 들어와도 primary `agentType`/project/model이 불필요하게 흔들리지 않도록 안정화

### 검증
- `./gradlew :app:compileDebugKotlin`
- `bash scripts/build-android-release.sh`
- `adb -s CREMAA21W09235 install -r dist/agentdeck-v0.3.0.apk`
- 설치 후 CremaS 캡처에서 `OpenCode` square, `Codex CLI` cloud, `OpenClaw`, 일반 agent가 동시에 보이는지 확인
- `adb shell ss -tan | rg 9120` 결과가 `127.0.0.1:9120` loopback 연결로 잡히는 것 확인

---
