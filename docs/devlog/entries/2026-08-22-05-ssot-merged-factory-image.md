# 2026-08-22 — 펌웨어는 잘 빌드돼서 아무도 닿지 못하는 곳에 쌓이고 있었다: 웹 플래셔 스파이크 + 보드 SSOT + merged factory image

### 문제

`esp32-v1.0.6` 의 에셋 31개가 **전부 다운로드 0회**다. 사이트 어디에서도 링크되지
않고, 유일한 플래시 경로 `esp32/scripts/flash.sh` 는 소스 체크아웃 + PlatformIO +
pyserial 을 전제한다. 즉 "펌웨어를 어떻게 넣는가" 가 ESP32 표면 전체의 진입 장벽인데
메인테이너만 통과할 수 있었다.

게다가 릴리스가 안내하는 USB 절차가 **불완전했다**:

- `boot_app0.bin`(0xe000) 이 릴리스에 아예 없다. 과거 OTA 가 app1 을 가리키게 해 둔
  otadata 가 남으면, 새 이미지를 app0 에 써도 **구버전으로 부팅**한다. 누락 원인이
  구조적이다 — 이 파일만 `.pio/build/` 가 아니라 Arduino 프레임워크 패키지 안에
  있어서, 빌드 디렉터리만 복사하는 수집 단계에 애초에 걸릴 수 없었다.
- 부트로더 오프셋을 말하지 않는다. 그 값은 칩마다 다르고 이 플릿은 **세 값**에
  걸쳐 있다 — esptool 기본표(`default 0x0, esp32 0x1000, esp32p4 0x2000`) 기준으로
  `ttgo_t_display`·`ulanzi_tc001` 0x1000, `ips_10` **0x2000**, 나머지 0x0.
- flash size 를 명시하지 않으면 헤더가 틀린다(TC001 은 4MB 기본값에서 부트로더
  오작동, IPS 3.5" 는 부트루프 중 8MB 오검출).

그래서 노트가 결국 "체크아웃해서 `pio run -t upload`" 로 되돌아간다.

### 해결

**Phase 0 — 하드웨어 스파이크(쓰기 0바이트).** 브라우저 `requestPort()` 는 자동화
불가능한 네이티브 다이얼로그를 띄우므로, esptool-js 가 Web Serial 포트에서 쓰는 6개
멤버(`open`/`close`/`readable`/`writable`/`setSignals`/`getInfo`)만 `serialport` 위에
어댑터로 구현해 **동일한 코드를 Node 에서 헤드리스로** 돌렸다. 이 어댑터는 CLI 플래셔가
어차피 필요로 하는 물건이라 버리는 비계가 아니다.

| 보드 | 칩(실측) | 판정 |
|---|---|---|
| `86box` | ESP32-S3 rev v0.2 | PASS (460800) |
| `t_display_pro` | ESP32-S3 rev v0.2 | PASS (230400 — 핀된 값 유지) |
| `ulanzi_tc001` | ESP32-D0WD rev 1 | PASS |
| `inkdeck` | ESP32-S3 rev v0.2 | PASS (460800) |
| `ttgo_t_display` | ESP32-D0WDQ6 rev v1.1 | PASS — **stub·no-stub 양쪽** |
| `t_embed` / `ips_10` | — | FAIL, **esptool.py 도 동일 실패** = 보드 측 |

**Phase 1 — 보드 SSOT.** 보드 목록이 네 곳(`hardware-compatibility.md` /
릴리스 매트릭스 / `cli.ts` / `docs/esp32.md`)에 있고 게이트는 한 변뿐이었다.
`shared/src/esp32-boards.ts` 가 기계 필드의 정본이 되고,
`scripts/generate-esp32-board-matrix.mjs` 가 릴리스 매트릭스를 **생성**하면서
나머지를 **양방향 교차 검증**한다. `cli.ts` 는 소비자가 됐다.

**Phase 2 — merged factory image + `manifest.json`.** 보드마다
`agentdeck-<board>-merged.bin` 을 만들어 **한 파일을 한 오프셋(0x0)** 에 쓰게 했다.
`manifest.json` 은 sha256/size 를 산출물에서 계산하고, 보드 하나라도 파일이 빠지면
릴리스를 실패시킨다.

### 핵심 설계 결정

**1. `--no-stub` 은 표현 가능하다 — 추론이 아니라 실측.** `main()` 은 `runStub()` 을
무조건 호출하지만 `detectChip()` 후 스텁을 건너뛰면 되고, `writeFlash` 에는 실제
`IS_STUB === false` 분기가 있다. TTGO 가 `default_reset/no-stub` 으로 연결되는 것을
확인했다. 플랜의 1순위 리스크였다.

**2. `detectFlashSize()` 는 모름을 `"4MB"` 로 위장한다.** 사이즈 ID 디코드 실패 시
조용히 4MB 를 반환한다. TTGO 를 stubless 로 읽으면 `flashId=0xffffff`(무응답)인데
그게 "4MB" 로 나왔고, 하마터면 **정상 16MB 보드를 불합격 처리**할 뻔했다. esptool.py 는
스텁 유무와 무관하게 정상 판독하므로 esptool-js 한계다. → flashId 를 **먼저** 보고,
모름은 모름으로 남긴다(verdict `pass-unknown-flash`).

**3. 플래시 크기 가드는 방향성이 있다.** 벽돌이 되는 건 `선언 > 실제` 뿐이다.
InkDeck 은 물리 16MB 인데 BSP 가 8MB 필드를 굽기 때문에 **8MB 로 선언해야** 하므로,
등호 비교였다면 올바른 설정을 불합격시켰을 것이다. → `선언 ≤ 검출`.

**4. 어댑터는 DTR/RTS 를 항상 함께 써야 한다.** serialport `set()` 은 생략한 신호에
자체 기본값을 넣고, esptool-js `setRTS()` 는 직후 DTR 을 재전송한다(usbser.sys 우회).
그래서 단일 신호 호출이 매 리셋 스트로브마다 다른 선을 덮어썼고, 증상은 "연결 실패"
로만 보였다. 첫 probe 가 전 전략 실패한 원인이 이것이었다.

**5. `--target-offset 0x0` 을 모든 보드에 적용한다.** classic 부트로더는 이미지
*안의* 0x1000 에 놓이고 merge-bin 이 앞을 `0xFF` 로 채우는데 ROM 은 그 구간을 읽지
않는다. 결과적으로 브라우저와 CLI 가 **칩별 분기 없이** 한 파일을 한 오프셋에 쓴다.
대신 자체 검사는 **부트로더 오프셋 지점을 잘라서** 해야 한다 — classic merged 이미지에
`image-info` 를 그냥 돌리면 `invalid magic number: 0xff` 로 실패한다.

**6. 자체 검사는 선택이 아니다.** merge-bin 은 flash 파라미터를 **출력물 안의 부트로더
사본에 패치**하므로, 헤더가 맞는지 아는 유일한 방법은 merged 파일에서 되읽는 것이다.
10보드 전부 로컬 실검증(ESP32/S3/C6/P4, 4·8·16MB, 오프셋 3종). Chip ID 도 실측:
ESP32=0, S3=9, C6=13, P4=18.

**7. 네이티브 USB 보드는 다운로드 모드 진입 시 디바이스 노드가 바뀐다.** InkDeck 은
원래 노드에서 실패하고 `usbmodem3111101` 에서 연결됐다. 웹 플래셔는 BOOT/RST 후
**포트를 다시 고르게** 해야 한다.

**8. 교차 검증이 실제 버그를 잡았다.** `docs/esp32.md` 가 `amoled_18` 을 OTA 별칭으로
안내하는데 CLI 는 받지 않았다 — 문서를 따른 사용자는 `No online WiFi ESP32 target
matches` 를 봤다. CLI 가 이미 `box_40`·`ips_101`·`knob`·`ticker`·`s3pro` 같은 flash.sh
친화명을 받으므로 배제가 아니라 **누락**으로 판단해 SSOT 에 추가했다.

### 남은 것

Phase 3(`/flash/` Pages 서피스 배선 + 실제 쓰기 경로), Phase 4(`agentdeck esp32 flash`),
Phase 5(문서/매트릭스/CHANGELOG). `t_embed` 은 물리 BOOT 조작, `ips_10` 은 TX 경로
규명, `ips_35`·`round_amoled` 는 USB 연결만 하면 측정 가능, `esp32_c6_147` 은 보드
부재로 C6 경로 전체가 미검증. 플랜: `~/.claude/plans/esp32-crystalline-bentley.md`

---
