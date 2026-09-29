# 2026-07-11 — Android WiFi adb 배포 경로 · BrandIcon pivot 버그 · D200H Swift 토폴로지 행

### 문제
- Android 대시보드 기기(e-ink 리더/태블릿) APK 업데이트가 매번 USB 케이블을 요구했고, in-app OTA는 기기별 설치확인 탭 + REQUEST_INSTALL_PACKAGES가 강제라 UX가 오히려 나쁘다.
- e-ink 타임라인 히어로 행(28dp)의 에이전트 브랜드 글리프가 좌상단 화면 경계 밖으로 이탈 — Compose `DrawScope.scale()`의 기본 pivot이 캔버스 중심이라 그림이 `center×(s−1)`만큼 밀리는데, 13dp 기본 크기(s≈1.08)에선 무증상이라 잠복해 있었다.
- Swift 데몬은 `client_register "ulanzi-plugin"`에서 direct-HID stand-down만 하고 토폴로지 registration을 만들지 않아, D200H가 Ulanzi Studio 경유로 정상 구동 중이어도 대시보드에 행이 없었다 (Node 데몬은 presence로 행 생성 — 티어 간 불일치).

### 해결
- `scripts/deploy-android-wifi.sh` 신설 (`c73263c3`): `enable`=USB 상태에서 `adbd tcpip:5555` 전환 + wlan0 IP를 `~/.agentdeck/android-adb-devices.json`에 기록, `deploy [--build]`=전 등록 기기에 최신 `dist/agentdeck-v*.apk` silent 설치 + 앱 재실행. Moaan Pantone6 · Crema S · Lenovo TB-J606F 3대 WiFi 트랜스포트로 실배포 검증. 재부팅 시 tcpip 모드가 풀리므로 USB 1회 재-enable 필요 (docs/android.md).
- `BrandIcon.kt`에 `scale(s, s, pivot = Offset.Zero)` (`547fb5e3`) — terrarium 크리처들이 이미 따르던 관례로 정렬. Crema 실기 `adb exec-out screencap` before/after로 검증.
- Swift 데몬에 `d200hHealthSnapshot()` 단일 chokepoint (`45377214`): dormant HID 모듈이 없으면 ulanzi-plugin WS presence로 `modules.d200h {connected, externalOwner, managerOpened}` 합성 (Node `moduleHealthProvider` 파리티), 플러그인 등록/해제 시 broadcast. UI는 `externalOwner`로 "Ulanzi Studio · 14 keys" 표기, 메뉴바 D200H 행 제목 정정. 플러그인 부재 시 키 자체를 생략해 D200H 없는 설치에서 ghost row가 없다.

### 핵심 설계 결정
- **Android 무선 업데이트는 in-app OTA가 아니라 adb-over-WiFi**: adb install은 무확인 silent이고 앱/데몬 코드 변경이 0 — 로컬 개발 플릿에는 상위 호환. 단 tcpip 모드는 재부팅 비영속이 트레이드오프.
- **D200H 토폴로지 행 부재 = 플러그인 미연결이지 물리 USB 부재가 아니다**: Ulanzi Studio가 떠 있으면 덱이 안 꽂혀 있어도 행이 뜬다. 물리 확인은 여전히 `system_profiler SPUSBDataType`.

### 검증
- WiFi 배포 3/3 Success + 데몬 재등록, Crema screencap 렌더 확인, `xcodebuild AgentDeck_macOS Debug` BUILD SUCCEEDED, 앱 재시작 후 `/health modules.d200h` + 대시보드 "USB HID · D200H · Ulanzi Studio · 14 keys" 라이브 확인. Codex usage bookmark는 재빌드에도 유지됨.

---
