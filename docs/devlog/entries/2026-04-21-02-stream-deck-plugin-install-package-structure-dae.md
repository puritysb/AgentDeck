# 2026-04-21 — Stream Deck plugin: install package structure + daemon port discovery + profile rename

### 문제
사용자 보고: Pixoo/D200H/TC001/macOS Terrarium 은 두 claude 세션 크리처를 정상 렌더하는데 **Stream Deck / Stream Deck+ 에서만 상태가 안 보인다**. App Store macOS 앱만 실행 중(CLI daemon 없음)이고 raw `claude` 인스턴스 2개가 훅만으로 동작하는 상태. 중간에 `pnpm package` 로 만든 `.streamDeckPlugin` 을 수동 재설치하려고 하자 Elgato 가 "플러그인 항목을 설치할 수 없다" 오류.

### 실제 근본 원인 (3겹 — 중요도 순)

1. **Plugin daemon.json 경로 단일화 누락.** `plugin/src/connection-manager.ts:findDaemonPort()` 가 `~/.agentdeck/daemon.json` 한 곳만 조회. Swift in-process daemon(App Store sandbox) 은 `~/Library/Group Containers/group.bound.serendipity.agentdeck.dashboard/daemon.json` 에 쓰므로 plugin 은 영구히 "daemon port=not found" 상태가 되고 모든 WS send 가 `dropped — not connected` 로 빠짐. 훅 스크립트는 이미 `cross_dir_daemon_discovery.md` 메모리 노트대로 **두 경로 모두** 시도하는데 plugin 만 구경로였음. **SD/SD+ 가 아무것도 렌더하지 않던 진짜 이유**.

2. **Package zip 구조.** `scripts/package-plugin.sh` 가 `.sdPlugin` 폴더 *내용물* 을 zip 루트에 넣고 있었음 (line 22 주석 "zip the .sdPlugin directory contents (NOT the .sdPlugin folder itself)" — 정반대가 맞다). Elgato 는 `<plugin>.sdPlugin/manifest.json` 구조를 기대하므로 `ContentError: No manifest.json found in package` 로 설치 거부. 추가로 `logs/` 디렉터리가 zip 에 포함되어 52MB 이상의 개발 로그가 배포 아티팩트에 묶여 9.3MB 패키지가 됨.

3. **번들 프로파일 하드웨어 바인딩.** `agentdeck-v4.sdProfile/manifest.json` 의 `Device.UUID: "@(1)[4057/132/A5Z5A41911U6X7]"` 가 특정 개발자 기기의 Stream Deck+ serial 에 고정돼 있어, 다른 유저의 SD+ 에서는 Elgato 가 device 매치에 실패해 AutoInstall 을 거부. 이 자체는 blocker 는 아니나(유저 기존 프로파일에 이미 AgentDeck 액션들이 세팅돼 있음) 공개 배포용 packaging 결함.

### 해결

**Plugin 쪽 (3 파일, 1 커밋)**:
- `plugin/src/connection-manager.ts` — `findDaemonPort()` 에 Group Container 경로 fallback 추가. 첫 live PID 매치 승리. 14 connection-manager 테스트 그대로 통과.
- `scripts/package-plugin.sh` — `.sdPlugin` 폴더를 zip 루트에 두고 `logs/` / `node_modules/` / `*.log` 제외. 9.3MB → 448K, Elgato 설치 성공.
- `plugin/.../manifest.json` + `plugin/src/plugin.ts` — 번들 프로파일 이름 `agentdeck-v4` → `agentdeck-sdplus` (Elgato 가 persist 한 "dropped embedded profile 'agentdeck-v4:7'" 캐시 우회 의도). 프로파일 폴더 이름, 내부 page UUID(598AC8E4 → D3714493), `switchToProfile(…)` 호출 인자 모두 동기화. `Device.UUID` 제거, `Plugin.Version` 0.3.0.0 → 0.4.0.0 일괄.

### 잔존 한계 (fixing X 로 남김)

Elgato 는 여전히 `import aborted [bound.serendipity.agentdeck]: no matching or required profiles found` 를 출력. 앱 완전 재시작, 심볼링크 대신 실제 복사본 설치, Device.UUID 제거, 이름 변경, 버전 정합까지 시도해도 같은 에러. Elgato 측 embedded-profile 인덱스가 바이너리 plist/메모리에만 존재하는 것으로 추정됨(문자열 grep 에 안 잡힘). **다만 실제 문제가 아님** — 사용자 `9F989E75-A8FF-4953-939E-FCA852F7FB6A.sdProfile` (SD+ Default Profile) 내부에 AgentDeck 액션들(Utility/Option/Usage/Voice/Session Slot) 이 이미 세팅되어 있어 AutoInstall 없이도 버튼 렌더링 작동.

### 핵심 설계 결정 (재발 방지 앵커)

- **"daemon.json 은 두 경로"는 프로토콜 레벨 invariant.** 훅 스크립트, plugin, 향후 도구 전부 Node `~/.agentdeck/` 와 Swift Group Container 두 곳을 조회해야 한다. 한 군데만 쓰는 소비자는 App Store 모드에서 조용히 죽는다. 메모리 노트 `cross_dir_daemon_discovery.md` 의 "3 경로 byte-identical" 가 hook snippet 에만 해당하는 착각을 유발하지 않도록 plugin connection-manager 에 이 주석을 박음.
- **Plugin packaging 구조는 `streamdeck pack` CLI 기준 — `.sdPlugin` 폴더가 zip 단일 top-level.** 과거 주석은 오해를 유도했고 `ContentError` 재발의 씨앗이었다. 스크립트 주석에 "Elgato rejects the package with 'No manifest.json found in package' unless the .sdPlugin folder is the zip's single top-level entry" 를 명문화.
- **번들 프로파일의 `Device.UUID` 는 절대 포함하지 않는다**. 특정 하드웨어에 고정되는 순간 다른 유저의 AutoInstall 이 실패한다. `Device.Model` 까지만.
- **Elgato 의 "dropped embedded profile" 상태는 클리어 불가 가정 하에 움직인다.** 프로파일 이름을 바꾸거나 내부 UUID 를 재생성하는 우회가 필요할 수 있음을 인지. 실제 사용자에게는 AutoInstall 실패해도 드래그 배치로 우회 가능하므로 blocker 로 다루지 않는다.

### 관련 파일
- `plugin/src/connection-manager.ts` — `findDaemonPort()` dual-path
- `scripts/package-plugin.sh` — zip 구조/제외 규칙
- `plugin/bound.serendipity.agentdeck.sdPlugin/manifest.json` — Profiles[0].Name
- `plugin/src/plugin.ts` — `switchToProfile(..., 'agentdeck-sdplus')`
- `plugin/bound.serendipity.agentdeck.sdPlugin/agentdeck-sdplus.sdProfile/` — rename + generic Device
- 커밋: `c64161e0 fix(plugin): Stream Deck package structure + cross-dir daemon.json discovery`

---
