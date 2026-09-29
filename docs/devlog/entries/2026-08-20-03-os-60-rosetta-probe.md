# 2026-08-20 — OS가 죽이는 자식을 60초마다 되살린 루프, 그리고 Rosetta가 통과한 probe

### 문제

이틀간 Python 크래시 리포트 77건, 오늘만 69건. 화면에는 크래시 대화상자가 계속 떴다.
직전 진단은 "Claude Code 훅이 TCC 보호 컨테이너 경로를 열어서"였는데 **틀렸다**.
`.ips` 파일의 둘째 줄부터가 JSON이고 거기 `termination.details` 가 사유를 문장으로
적어둔다: `NSBluetoothAlwaysUsageDescription` 부재 — 파일 접근이 아니라 **CoreBluetooth**
다. 부모는 훅이 아니라 데몬(node)이었고, 범인은 Timebox Mini의 BLE 워커 재스폰 루프였다.

원인은 둘이고 서로를 가렸다. **① TCC의 Bluetooth 허용은 번들 없는 바이너리에 대해
경로에 고정된다.** TCC.db에는 `.../node/26.3.0/bin/node`, `.../claude/versions/2.1.234`
같은 행이 있다 — brew가 node를 26.5.0으로 올리고 claude가 2.1.237로 자동 업데이트되는
순간 허용이 조용히 사라지고, 번들이 없으니 재프롬프트도 못 하고 그냥 SIGABRT로 죽는다.
그런데 재스폰 관리자는 이걸 여느 실패와 똑같이 취급해 60초 뒤 다시 띄웠다. 성공할 수
없는 루프가 하루 60번 넘게 크래시 대화상자를 만든 것이다. **② 그 워커는 Rosetta에서
돌고 있었다.** 6월에 만들어진 repo 루트 레거시 `.venv` 가 인텔 Homebrew 파이썬
(`/usr/local`)으로 생성돼 있었고, 정식 위치에 venv가 없어 런타임이 거기로 폴백했다.
`dependencyProbe` 는 이걸 못 잡는다 — 번역된 인터프리터도 bleak/PIL을 멀쩡히 import한다.

### 해결

**서킷 브레이커** (`createSigabrtCircuitBreaker`, timebox·idotmatrix 양쪽 배선):
연속 SIGABRT가 3회면 재스폰을 멈추고, 원인(macOS라면 TCC Bluetooth)과 복구 경로
(권한 부여 → `agentdeck daemon restart`)를 로그와 `/health` 링크 상태에 남긴다.
클린 종료("device not found")는 스트릭을 리셋하므로, 꺼진 패널을 하루 종일 스캔하는
정상 루프는 절대 걸리지 않는다.

**Rosetta 가드** (`python-ble-runtime.ts`): 인터프리터의 Mach-O 헤더를 직접 읽어
(thin·fat 둘 다) arm64 맥에서 x86_64 전용 파이썬을 거부하고 재빌드를 안내한다.
`ensureBleRuntime` 은 그런 venv를 **지우고** 다시 만든다 — 그 위에 `-m venv` 를 다시
돌리면 인터프리터만 갈리고 site-packages의 잘못된 아키텍처 네이티브 휠이 남는다.
그리고 `/opt/homebrew/bin/python3` 를 PATH의 `python3` 보다 먼저 probe한다: 데몬이
띄우는 셸은 `/etc/paths` 순서를 타서 `/usr/local` 이 앞선다.

실측: venv 재생성 + 데몬 재시작 후 두 워커 모두 arm64 Python 3.14.6으로 뜨고,
재시작 이후 새 크래시 리포트 0건, 5분 로그 감시에서도 kill 없음.

### 핵심 설계 결정

- **크래시는 추측하기 전에 읽는다.** `.ips` 의 `termination.details` 는 macOS가 왜
  죽였는지를 문장으로 말해준다. 스택 프레임 모양만 보고 "파일 접근이겠거니" 한 것이
  직전 세션의 오진 전부였다.
- **"OS가 죽였다"는 "실패했다"와 다른 사건이다.** 재스폰 관리자는 두 가지를 구분해야
  한다 — 백오프로 낫는 것과, 사람이 권한을 주기 전까지는 몇 번을 되살려도 같은 자리에서
  죽는 것. 후자를 계속 되살리면 복구가 아니라 증폭이다.
- **아키텍처는 바이너리만이 말한다.** 동작 probe(import 성공)는 Rosetta를 통과시키므로
  아키텍처 판정에 쓸 수 없다. 그리고 모르는 형식(스크립트, ELF, 잘린 파일)에는 아무
  주장도 하지 않는다 — x86_64 슬라이스가 **있고** arm64 슬라이스가 **없을 때만** 거부.

---
