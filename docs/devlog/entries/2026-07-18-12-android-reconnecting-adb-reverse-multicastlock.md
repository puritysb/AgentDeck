# 2026-07-18 — Android 기기 "reconnecting" 고착: 원인은 adb reverse가 아니라 MulticastLock 부재

### 문제

Swift 데몬 단독 실행 중 CremaS와 Lenovo 태블릿만 영구 reconnecting에 빠졌다 (Pantone6는 정상). 표층 원인은 명확해 보였다: Swift `AdbModule`은 App Store 무서브프로세스 불변식 때문에 status-only stub이라 adb reverse 터널을 걸지 않고, Node 데몬 시절 걸린 터널은 USB 재연결에 소멸한다 → `ws://127.0.0.1:9120` 경로 기기가 고착.

그런데 앱에는 이미 이 상황의 방어가 있었다 — "mDNS preempts USB attempt" 래더(6fb8566f, 태블릿/e-ink 두 스크린 모두). 방어가 있는데도 실패한 이유가 진짜 문제였다.

### 해결

**Android 앱이 MulticastLock을 잡지 않아, 멀티캐스트를 하드웨어 필터링하는 WiFi 칩셋에서는 NSD가 데몬의 `_agentdeck._tcp` 광고를 아예 수신하지 못했다.** 칩셋 의존적이라 Pantone6만 통과 — "일부 기기만 안 붙는" 패턴의 정체. 데몬 광고 자체는 `dns-sd -L`로 정상 확인(`agent=daemon ip=… port=9120`).

`BridgeDiscovery.rawDiscover`에서 공유 discovery flow 수명 동안 MulticastLock을 획득(`awaitClose` 해제, 5초 stop-timeout이 배터리 비용 한정)하고 `CHANGE_WIFI_MULTICAST_STATE`/`ACCESS_WIFI_STATE` 권한을 추가했다 (`bd3338bb`). 검증은 reverse 터널을 전부 제거한 상태에서 3기기 모두 WiFi 순수 경로로 daemon 등록 확인.

### 핵심 설계 결정

- **연결 경로는 티어 독립이 정답.** mDNS→WiFi가 primary (Tier 1 Swift 데몬 단독으로 충분), adb reverse는 Node 데몬 실행 시의 보조 경로. localhost-first 래더는 유지하되 preempt가 실제로 동작하려면 기기 수신측이 멀쩡해야 한다.
- **"기기별로 갈리는 mDNS 미발견"은 광고측이 아니라 수신측부터 의심.** 데몬 Bonjour는 macOS에서 `dns-sd -B/-L`로 1분 안에 판정 가능; 그 다음 용의자는 Android MulticastLock/칩셋 필터링이다.
