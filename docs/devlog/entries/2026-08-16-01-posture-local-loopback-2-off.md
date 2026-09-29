# 2026-08-16 — 기업/공용 네트워크 posture: `--local`·`--loopback` 2축과 "off 는 파생"

#198 의 세 워크스트림 중 이 건만 로그 항목이 없었다. 회사처럼 **한 네트워크에
사용자가 여럿, 각자 자기 데몬**인 상황을 조사한 결과다(공유 *머신* 시나리오는
없다고 확인 — `docs/ENTERPRISE-ROADMAP.md` §1 에 남겨두고 착수하지 않음).

### 문제

- `AGENTDECK_LOOPBACK_ONLY=1` 은 **바인드 주소 한 줄만** 골랐다. 그 플래그를 켠
  데몬이 계속 `_agentdeck._tcp` 를 광고하고, 2초마다 UDP 비컨을 쏘고, Pixoo 를
  찾아 /24 를 훑고, BLE 를 스캔했다 — **아무도 닿을 수 없는 서비스를 위한 소음**.
  시작 로그는 "LAN devices cannot connect" 라고만 해서 관리자가 스윕이 도는 걸 알
  방법이 없었다.
- `--local` 의 모듈 레코드가 **리터럴 나열**이었다. `initModules` 는 없는 키를
  `'auto'` 로 읽으므로, 레코드 작성 이후 추가된 모듈은 전부 켜진 채였다. "Disable
  all device modules" 라고 문서화된 플래그가 iDotMatrix Python BLE 클라이언트를
  띄우고 있었고, 더 나쁜 건 **`--local` 이 아닌 기본 세션 경로에도** 같은 구멍이
  있어 매 `agentdeck claude` 세션이 데몬 것과 별개로 BLE 클라이언트를 하나씩 더
  스폰했다.
- Pixoo 자동발견이 기본 on 이라, Pixoo 를 안 쓰는 머신도 데몬 시작마다
  `app.divoom-gz.com` 에 POST 하고 로컬 /24 254 호스트를 HTTP 프로브했다. 기업
  기준으로는 미고지 3rd-party egress + IDS 가 수평 스캔으로 읽는 트래픽이다.

### 해결

`bridge/src/network-posture.ts` 가 SSOT. 시작 시 `resolveDaemonPosture()` 로 **한 번**
결정해서 바인드·모듈셋·시작 로그가 서로 어긋날 수 없게 했다.

| 스위치 | 바인드 | mDNS/UDP | Pixoo 스윕·BLE | USB serial·ADB reverse |
|---|---|---|---|---|
| 기본 | `0.0.0.0` | on | on | on |
| `--local` | `0.0.0.0` | off | off | **off** |
| `--loopback` (≡ env) | `127.0.0.1` | off | off | **on** |

- `allModulesOff()` 는 `MODULE_NAMES` 에서 **파생**하고, `createDefaultModules()` 와
  대조하는 vitest 게이트를 걸었다. 제한 분기는 `{ ...allModulesOff(), <허용분> }`
  으로 쓴다 — 나중에 추가된 모듈의 실패 모드가 "꺼짐"이 되도록.
- **autostart 에 굽는다.** `daemon install --enterprise` 가 LaunchAgent /
  Scheduled Task / systemd unit 의 **argv** 에 플래그를 넣는다(Task Scheduler 에는
  environment 요소가 없어서 argv 가 셋의 유일한 공통 채널). 백그라운드 fork 도
  플래그를 전달하고, `daemon restart` 는 돌던 데몬의 posture 를 `/health` 에서 읽어
  승계한다. `npx @agentdeck/setup --enterprise` 는 `--yes` 를 함의하고 여기까지 한다.
- Pixoo 자동발견 기본 **off** (Node + Swift). `pixoo scan` 에 `--no-cloud` 를 붙여
  클라우드 조회와 서브넷 스윕을 분리했다(서로 다른 disclosure).

### 핵심 설계 결정

- **두 축을 한 플래그로 접지 않는다.** `--local` = "하드웨어를 구동해도 되나",
  `--loopback` = "LAN 에서 보이거나 들려도 되나". 랩 서브넷에 하드웨어는 두되
  디스커버리는 끄고 싶은 곳이 있다.
- **`--loopback` 에서 USB 채널(serial + ADB reverse)은 산다.** 케이블에 물린
  보드는 네트워크 피어가 아니다. ADB reverse 는 처음에 "보안 posture 는 꺼짐이
  안전한 기본값"이라며 껐다가 하루 만에 뒤집었다(08-17): `adb reverse` 는 기기의
  localhost 를 **호스트 자신의 loopback** 으로 넘기는 USB 터널이라 127.0.0.1
  바인드에서 그대로 동작하고 LAN 에 아무것도 내보내지 않는다 — serial 을 살린
  판정과 동일한 시험을 통과하는데 결과만 달랐던 것. 끄면 USB 테더링 안드로이드
  대시보드 3대가 보안 이득 0 에 조용히 죽는다. "quiet by default" 는 LAN 방출이
  있는 모듈에만 적용할 논리다. `--local` (모듈 전체 off)은 여전히 ADB 를 끈다.
  단 이 "USB 채널" 판정은 가정이 아니라 강제다: `adb reverse` 는 네트워크
  transport(`adb connect <ip>:5555`, 무선 디버깅 mDNS)에도 똑같이 걸리고 그 경우
  터널이 LAN 을 타므로, loopback 에서는 `isNetworkAdbTransport` 가 USB serial 형태만
  통과시킨다(적대적 리뷰가 잡은 구멍 — "USB 채널이라 안전"이라는 문장 자체가
  transport 를 확인하지 않으면 거짓이 된다).
- **자동발견을 끄면서 만든 회귀 2건을 되돌렸다.** ① Swift `attemptRediscoverIfStuck`
  가 자동발견 게이트 뒤에 있어서, 등록된 패널의 DHCP 주소가 바뀌면 영구 블랙아웃이
  됐다. 게이트를 뺐다 — **사용자가 등록한 기기의 주소를 다시 찾는 것은 모르는 기기를
  찾는 것과 다른 행위**다. ② Pixoo64 는 App Store 티어 기능인데 앱의 Pixoo 시트는
  IP 수동 입력 전용이고 Tier 1 에는 `agentdeck pixoo scan` 이 없다. **Settings →
  Pixoo → Scan LAN** 버튼을 추가하고 데몬 모듈의 `sweepSubnet`/`localIPv4Subnets`
  를 그대로 재사용했다(손미러 금지). 찾은 IP 는 명시적 Add — 공용 서브넷에서 옆자리
  패널을 조용히 채가지 않도록.
- **`posture` 를 `/health` 에 실은 게 두 번 쓰인다**: `daemon restart` 승계, 그리고
  `qr`/`pair` 가 loopback 데몬에서 **연결 불가능한 LAN URL 을 말없이 출력하던 함정**
  차단(이유를 말하고 출력한다). Swift 데몬은 이 필드를 안 내보내므로 양쪽 다 조용히
  무동작 — 오작동은 없다.

### 미검증 / 남은 것

- ~~**실제 loopback 데몬 기동은 확인하지 못했다.**~~ → 08-17 **실측 완료**(운영 9120
  데몬, master d7d92efa 빌드): 바인드는 `127.0.0.1` 만(LAN IP 로 건 curl 은 TCP
  거부), `dns-sd -B _agentdeck._tcp` 에 광고 없음, health 에서 `pixoo` 키가 사라지고
  timebox/idotmatrix 는 `sync module not started`, **USB serial 보드 5대와 ADB
  reverse(HVA095B4) 는 그대로 생존**, 시작 로그도 약속한 문장 그대로 출력.
  `daemon stop`→`start` 로 기본 posture 복귀까지 확인.
  **다만 격리 테스트는 여전히 불가**: `AGENTDECK_DATA_DIR` + `-p 9200` 으로 띄워도
  싱글톤 가드의 **포트 윈도우 스윕**(9120–9139)이 운영 데몬을 발견해 `process.exit(0)`
  한다 — 명시 포트로도 우회되지 않는다(가드 자체는 올바른 동작). 그래서 posture
  실기동 검증은 **운영 데몬을 잠깐 그 posture 로 재시작하는 것이 유일한 경로**다.
  로드맵 11번(포트 윈도우 설정화)이 들어오면 이 제약이 풀린다.
- ~~**Swift 데몬에는 posture 스위치가 없다.**~~ → 08-17 해소(로드맵 12번 done):
  **Settings → Local server** 에 Loopback only / Disable device modules 토글
  (`AppPreferences.daemonLoopbackOnly`/`daemonNoDeviceModules`) → `DaemonPosture`
  로 한 번 결정, 토글 변경은 데몬 재시작으로 적용. loopback 이면 `NWListener` 가
  `requiredLocalEndpoint` 로 127.0.0.1 바인드하고 Bonjour 광고를 아예 안 붙이며,
  `startDeviceModules` 는 `allowsModule()` deny-by-default 게이트로 모듈을
  **생성 자체를 안 한다**(등록만 건너뛰면 미등록 모듈이 observer/broadcast 경유로
  살아남는다). posture 는 Swift `/health` 에도 실려 `qr`/`pair` 경고와 `daemon
  restart` 승계가 Node 와 동일하게 동작. XCTest `DaemonPostureTests` 가 Node
  `network-posture.test.ts` 의 케이스를 미러링.

---
