# 2026-04-08 — D200H Swift 렌더 경량화 + ZIP 스펙 정합성 + Consumer 입력 fallback

### 문제
Swift D200H 경로를 다시 실기 로그 기준으로 점검한 결과, 단순 HID open 실패만이 아니라 payload 자체에도 문제가 있었다.

1. 버튼 텍스트를 PNG에 직접 굽는 경로가 다시 들어와 ZIP/PNG 크기가 커졌다.
2. boundary padding을 위해 ZIP local/central header extra 영역에 raw `0x41` filler를 바로 넣어, Python `zipfile`이 손상으로 판정하는 비정상 extra field를 만들고 있었다.
3. 현재 macOS 앱 빌드에서는 Keyboard HID 인터페이스가 `kIOReturnNotPermitted`로 막히지만 Consumer 인터페이스는 열리는 경우가 있어, 화면은 갱신돼도 입력이 죽을 수 있었다.

### 해결
- Swift `D200hHidModule.swift` 렌더 경량화:
  - 일반 버튼 PNG를 `icon-only`로 축소
  - 버튼 라벨은 manifest `ViewParam.Text`로 다시 이동
  - usage merged slot도 커스텀 gauge/text PNG 대신 icon-only half PNG + native text(`5H xx%`, `7D yy%`)로 단순화
- ZIP extra field 정합성 수정:
  - boundary shift는 계속 local header extra field padding으로 수행
  - 단, extra bytes를 raw filler가 아니라 `header(0x4141) + length + payload` 형식의 유효한 ZIP extra field로 생성
  - 같은 수정 적용: Swift `D200hHidModule.swift` + Node `bridge/src/d200h/image-renderer.ts`
- Consumer input fallback:
  - Swift 구현도 Node와 동일하게 Consumer Control 인터페이스에 input callback을 등록
  - Keyboard interface open이 막혀도 button report가 Consumer 쪽으로 들어오면 입력을 받을 수 있게 준비

### 검증
- `xcodebuild -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS' -derivedDataPath /tmp/AgentDeckDerivedDataD200HZipSpec build CODE_SIGNING_ALLOWED=NO`
- `pnpm --filter @agentdeck/bridge build`
- 새 Swift dump 기준:
  - `~/.agentdeck/d200h-dumps/20260408-132027-552-set_buttons-L-33219b-OPENCLAW_OPENCLAW__.zip`
  - boundary invalid byte `bad=0`
  - Python `zipfile.ZipFile(...)`로 정상 파싱
  - `icons/btn0.png` 약 `2274 bytes`까지 감소
  - 전체 `SET_BUTTONS` ZIP `33219 bytes / 33 packets`
- 런타임 health 기준:
  - Consumer interface 연결 + 반복 `SET_BUTTONS` 송신 유지
  - sessions relay 연결 후 `sessionsCount: 2`
  - Keyboard interface는 여전히 `kIOReturnNotPermitted` 가능성 잔존

### 핵심 설계 결정
- **D200H는 텍스트보다 native label을 우선한다.** PNG는 icon-only로 유지해 펌웨어 허용 범위에 맞춘다.
- **boundary fix만으로는 부족하다.** ZIP도 표준 파서가 읽을 수 있는 형태여야 reverse-engineering / oracle 비교가 가능하다.
- **입력 fallback도 Consumer-first로 준비한다.** Keyboard HID 권한이 막히는 macOS 빌드가 실제로 존재하므로 Consumer callback을 항상 붙여 두는 쪽이 안전하다.

---
