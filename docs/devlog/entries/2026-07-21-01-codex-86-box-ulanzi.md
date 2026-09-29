# 2026-07-21 — Codex 사용량 실종, 86 Box 이중 환경 통합, Ulanzi 게재 경로

### 문제

**Codex 사용량 게이지가 안 뜬다.** 권한이나 Codex 쪽 문제로 보였지만 아니었다.
`~/.codex` 북마크는 살아 있고 `auth.json` 도 정상 파싱되어 plan/account/mode 가
다 채워지는데, `codexRateLimits` 만 통째로 없었다. 최신 rollout 에는
`rate_limits` 줄이 203 개 있고 마지막 줄은 EOF 에서 4KB — 256KB tail 창 한참
안쪽이었다.

**86 Box 에 살아있는 환경이 둘.** `rgb48` 과 `box_86`. 문서는 "legacy
duplicate" 라고 적어뒀지만 중복이 아니었다. `rgb48` 은 LovyanGFX /
espressif32@6.9.0(gnu++11), `box_86` 은 Arduino_GFX / pioarduino 로 **그래픽
스택 자체가 다르고**, `BOARD_RGB48` 전용 블록 8곳이 그 차이를 흡수하고 있었다.
게다가 `default_envs = rgb48` 인데 릴리스 매트릭스는 `box_86` 을 빌드했다.

**Ulanzi 리스팅이 저장되지 않는다.** 업데이트 클릭이 계속 실패.

### 해결

**tail 이 텍스트가 되지 못했다.** `size - maxBytes` 로 seek 하면 임의 바이트에
착지하므로 창은 거의 항상 줄 중간에서 — 한글이면 **문자 중간**에서 — 시작한다.
`String(data:encoding:.utf8)` 는 엄격해서 문자 하나만 잘리면 **256KB 전체에
nil** 을 반환한다. 실측: 창 첫 바이트가 continuation byte `0x90`, 관대
디코딩이면 65 개를 찾는다. Node 의 `buf.toString('utf8')` 은 관대해서 이 버그가
없고, **9120 을 누가 잡느냐로 증상이 갈렸다**. `TailDecoder` 로 부분 선두 줄을
버린 뒤 디코딩하도록 고쳤고, 같은 패턴을 훑어 `DaemonServer.readTail` 과
`ClaudeTranscriptTailReader` 도 함께 고쳤다 — 후자는 Stop hook 이 응답 텍스트를
~18% 만 실어주는 탓에 턴 완결의 권위 소스라 영향이 더 크다.

**`box_86` 으로 통합.** 다른 S3 보드 전부와 같은 플랫폼이고 CH340 플래그를
갖췄으며 릴리스 매트릭스·docs·OTA 목록이 이미 가리키던 쪽이다. 통합 과정에서
실제 결함이 드러났다 — `main.cpp` 보드 이름 체인에 `BOARD_BOX_86` 이 없어
**릴리스가 빌드하는 펌웨어가 자기 보드를 "Unknown" 으로 보고**하고 있었다.
매트릭스가 한 번도 안 돌아서 아무도 못 잡았다. TC001(`led8x32`) 도 매트릭스에
추가해 6 → 7.

**Ulanzi 는 우리 문제가 아니었다.** 프론트엔드가 audit 상태 항목에 대해
`updateAuditResources` / `removeAuditResources` 를 호출하는데 백엔드에
`*AuditResources` 계열이 통째로 없다(일반 분기인 `updateResources` /
`removeResources` 는 200). 수정도 삭제도 막혀 자력 우회로가 없다. 게다가 지원팀
확인 결과 **Marketplace 게재 자체가 메일 요청 기반 수동 절차**였다 — my uploads
는 심사 대기열이 아니다.

### 핵심 설계 결정

- **바이트 오프셋 tail 읽기는 줄 경계로 정렬한다.** JSONL 이므로 부분 선두 줄을
  버리는 것이 곧 유효한 UTF-8 경계 복원이다. Swift 의 엄격 디코딩과 Node 의
  관대 디코딩 차이는 앞으로도 양 데몬 동작을 가르는 함정이다.
- **보드 환경이 둘이면 둘 중 하나는 검증되지 않는다.** `default_envs` 와 릴리스
  매트릭스가 서로 다른 env 를 가리키면 실기 검증과 배포본이 갈라진다. 통합 후
  7 보드 전부 빌드 + OTA 실기 확인까지 했다.
- **공유 코드를 건드리는 리팩터는 전 보드 빌드로만 검증된다.**
  `terrarium/renderer.cpp` · `draw.h` 는 전 보드 공유라, 첫 시도에서 `#elif`
  분기를 날려 3 보드를 깼고 전체 매트릭스 빌드에서만 드러났다.

---
