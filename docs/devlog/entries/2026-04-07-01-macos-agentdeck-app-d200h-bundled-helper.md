# 2026-04-07 — macOS AgentDeck.app D200H bundled helper 승격

### 문제
Swift `AgentDeck.app` 안의 샌드박스 daemon은 D200H HID open에서 `kIOReturnNotPermitted`가 발생해 기기가 기본 펌웨어 화면으로 복귀했다. 사용자는 CLI를 수동 실행하거나 UlanziStudio/공식 SDK에 의존하지 않고, **앱 하나로 D200H를 정상 운용**하길 원했다.

### 해결
- `apple/scripts/copy-adb.sh`에서 앱 번들 `Contents/Helpers/`에 D200H helper runtime을 함께 복사:
  - `node`
  - `agentdeck-d200h-helper`
  - `agentdeck-runtime/bridge/dist`
  - 필요한 `node_modules`
- `DaemonService`에 `startBundledD200HHelper()` 추가. 앱이 로컬 daemon을 내리고 번들 helper를 직접 띄운 뒤 `/health`가 올라오면 해당 daemon에 클라이언트로 재연결한다.
- D200H 상태 헬스에 `sandboxEnabled`, `usbEntitlementPresent`, `lastOpenError`를 포함시켜 Swift 쪽이 권한 실패를 명시적으로 감지하도록 했다.
- 로컬 Swift daemon health check에서 `USB entitlement 없음` 또는 `kIOReturnNotPermitted`가 보이면 사용자가 CLI를 만지지 않아도 **앱이 자동으로 번들 D200H helper로 승격**되게 했다.
- Settings에 `Auto-switch D200H to bundled helper` 토글과 수동 강제 전환 버튼 추가.
- D200H 역공학용 도구 추가:
  - Swift daemon이 실제로 만든 `SET_BUTTONS` / `PARTIAL_UPDATE` ZIP을 `~/.agentdeck/d200h-dumps/`에 dedupe dump
  - `zkswe/recon/ulanzi_hid_capture.c` + `build-ulanzi-hid-capture.sh`로 macOS `IOHIDDeviceSetReport` interpose 캡처
  - `zkswe/recon/d200h_zip_tool.py`로 raw packet → ZIP 재구성 및 ZIP/manifest 비교
- Swift/Node ZIP builder 결함 수정:
  - 기존 dummy-file padding 방식은 앞쪽 PNG data에 걸린 invalid boundary byte를 절대 고칠 수 없었음
  - dump 분석 결과 실제로 `16376`, `23544`, `30712` 같은 boundary offset에 `0x00`가 반복적으로 남아 있었음
  - 해결: ZIP local header extra field padding을 엔트리별로 조정하는 방식으로 전환
  - 검증: 새 dump `20260406-161556-747-set_buttons-L-45019b-OPENCLAW_OPENCLAW__.json` 기준 invalid boundary byte `bad=0`

### 핵심 설계 결정
- **"CLI fallback"이 아니라 "app-owned helper"**: 사용자는 `AgentDeck.app`만 실행한다. helper는 앱 번들 내부 자산으로 배포·기동되고, 제어권도 AgentDeck에 남긴다.
- **Ulanzi SDK/Studio 비채택 유지**: 공식 SDK는 UlanziStudio 플러그인 모델이라 호스트 제어권이 Ulanzi 앱에 묶인다. 우리의 목적은 AgentDeck이 직접 D200H 상태/렌더/입력을 소유하는 구조다.
- **자동 승격 조건은 D200H 권한 실패 신호에 한정**: 단순 연결 지연이 아니라 `sandbox + no USB entitlement` 또는 `open denied`일 때만 helper로 넘어가 불필요한 전환을 막는다.
- **공식 앱은 runtime dependency가 아니라 protocol oracle**: UlanziStudio를 제품 경로로 쓰지 않고, 필요할 때 `IOHIDDeviceSetReport` 캡처 대상으로만 활용해 vendor ZIP/manifest 규약을 복제한다.

---
