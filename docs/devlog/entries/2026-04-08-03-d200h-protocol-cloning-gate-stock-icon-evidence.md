# 2026-04-08 — D200H Protocol Cloning Gate: Stock Icon Evidence + Compare Tooling

### 문제
사용자는 D200H를 단순 safe-path 아이콘 기기가 아니라, 가능한 한 Stream Deck 수준의 시각 밀도와 동작으로 끌어올리길 원했다. 이 시점에서 판단해야 할 것은 두 가지였다.

1. stock firmware 위에서 vendor protocol을 복제하는 경로가 아직 유효한가
2. 아니면 device takeover를 주 경로로 승격해야 하는가

하지만 오늘 작업 환경에는 `UlanziStudio.app`가 설치되어 있지 않아 live `IOHIDDeviceSetReport` 캡처를 바로 뜰 수 없었다.

### 해결
- `zkswe/recon/build-ulanzi-hid-capture.sh`로 vendor HID interpose capture 도구를 다시 빌드해, live capture 준비 상태는 유지했다.
- `zkswe/recon/d200h_zip_tool.py`를 보강했다:
  - `profile` 서브커맨드 추가
  - ZIP뿐 아니라 `manifest0_json.txt` 같은 manifest dump도 직접 분석 가능
  - `Action`, `State`, `ViewParam.Text`, `ViewParam.Icon` 분포와 PNG 크기 통계를 바로 출력
  - `compare`는 이제 ZIP과 manifest source를 섞어 비교 가능
- 기존 stock dump를 기준으로 stock firmware의 허용 범위를 수치로 고정했다:
  - `zkswe/recon/dumps/20260327_214855/manifest0_json.txt`
  - `zkswe/recon/dumps/20260327_214855/res_listing.txt`
- 분석 결과:
  - stock `manifest0.json`: 버튼 19개, `Text` 비어 있음 19개, `system.open` 액션 18개, `smallwindow.window` 1개
  - stock 기본 icon: 14종, 참조된 PNG 크기 `29255`~`35837` bytes, 평균 `32154.8` bytes
  - 즉 stock firmware는 "텍스트를 거의 쓰지 않는 icon-first 버튼"을 기본값으로 삼고 있고, rich PNG도 충분히 싣고 있다
- 우리 최신 AgentDeck D200H dump는 여전히 작은 PNG + label fallback 비중이 높다:
  - partial update 기준 `text='OpenClaw'`, `icon='icons/btn0.png'`, PNG 약 `4.6KB`
  - stock의 기본 icon 밀도와는 아직 차이가 크다

### 검증
- `bash zkswe/recon/build-ulanzi-hid-capture.sh` 성공
- `python3 zkswe/recon/d200h_zip_tool.py profile zkswe/recon/dumps/20260327_214855/manifest0_json.txt --res-listing zkswe/recon/dumps/20260327_214855/res_listing.txt`
  - stock manifest/action/text/icon 분포 출력 확인
  - stock icon 파일 크기 통계 확인
- `python3 zkswe/recon/d200h_zip_tool.py compare zkswe/recon/dumps/20260327_214855/manifest0_json.txt <latest AgentDeck partial_update zip>`
  - stock은 `Action`/`ActionParam`/icon-only 구조
  - AgentDeck은 `Action=<none>` + `Text='OpenClaw'` 경향
- `python3 -m py_compile zkswe/recon/d200h_zip_tool.py` 성공

### 핵심 결론
- **protocol cloning은 아직 죽지 않았다. 오히려 주 경로로 유지해야 한다.**
  - stock firmware 자체가 rich icon을 충분히 사용한다는 증거가 나왔다.
  - 따라서 현재 한계는 "D200H 패널의 본질적 한계"보다 "우리가 아직 vendor-accepted payload semantics를 정확히 못 맞춘 상태"에 가깝다.
- **takeover는 계속 연구 트랙으로 유지한다.**
  - MI_GFX visible target, boot timing, ADB 안정성, 14-key 입력 매핑까지 모두 제품화 수준으로 정리되지 않았다.
  - takeover는 자유도 상한은 높지만, 당장 Stream Deck 수준 제품을 만드는 가장 빠른 길은 아니다.

### takeover 승격 조건
- 다음 조건을 충족해도 stock firmware가 richer button image를 계속 무시하면 takeover를 주 경로로 승격한다:
  1. vendor payload live capture 확보
  2. manifest semantics를 stock 쪽에 더 가깝게 정렬
     - icon-first
     - `Text` 최소화
     - `Action` / `ActionParam` 채움
  3. richer PNG 크기와 ZIP 구조를 vendor/stock 허용 범위에 맞춤
- 반대로 위 정렬만으로 full-image button acceptance가 살아나면, takeover는 백업 경로로 남긴다.

---
