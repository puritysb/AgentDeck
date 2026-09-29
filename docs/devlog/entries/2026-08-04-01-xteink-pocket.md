# 2026-08-04 — XTeink Pocket: 오프라인에서 쓸수록 나아지는 자율 카드 피드

### 문제
X3/X4가 WiFi 밖으로 나가면 기존 AgentDeck 화면은 마지막 세션 상태를 보여주는 데
그쳤다. 사용자가 매번 Pocket 내용을 직접 입력·관리하게 하면 작은 전자책 기기의
휴대 가치가 생기지 않고, 처음부터 추천 종류를 고정하면 아직 모르는 사용자 취향을
제품 정책으로 단정하게 된다. 또한 ESP32-C3에는 PSRAM이 없으므로 무제한 추천 큐나
문자열 학습 로그를 기기에 둘 수도 없다.

### 해결
- Node daemon에 `AutonomousPocketEngine`을 추가했다. 이미 한 번 해석된 세션과
  `CardFeedGlance`(일정·날씨·사용량·wrap-up)에서 후보를 만들고, `pulse`/`nudge`/
  `quest` module card 최대 2장을 기존 `THREAD`와 함께 `/feed`로 제공한다. 후보별
  추가 fetch는 없다.
- 이력이 없으면 어떤 영역을 먼저 배울지 묻는 `quest`로 시작한다. 이후에는 종류별
  반응 집계, 시간대 친화도, cooldown, 미관측 보너스를 합친 결정적
  exploration/exploitation 점수로 매 pull의 작은 후보 집합을 다시 고른다.
- XTeink hand-port는 고정 3-card Pocket pool만 파싱·SD snapshot 저장한다. Pocket은
  WiFi가 없어도 열리고, 1번은 Later, 2–4번은 stable choice ID를 SD Outbox에 먼저
  기록한다. 연결이 돌아오면 기존 `/outbox` 경로로 전송된다.
- 같은 `cardId`의 첫 답만 학습에 반영해 retry를 idempotent하게 만들었다. full feed
  노출 뒤 24시간 무반응은 약한 음수 신호이고, conditional unchanged pull은 노출로
  세지 않는다.
- `pocket-autonomy.json`에는 집계 counter, coarse hour bucket, opaque fingerprint/card
  ID와 시각만 남긴다. 카드 문구, 프로젝트/세션명, 일정 제목, 날씨·provider 원문은
  학습 상태로 복제하지 않는다. 상태와 seen/pending 집합도 상한·prune을 둔다.

### 핵심 설계 결정
- **Pocket의 편집자는 사용자가 아니라 daemon이다.** 기기는 한 번의 읽기와 한 번의
  선택에 집중하고, 콘텐츠 종류와 순서는 실제 반응으로 점진적으로 바뀐다.
- **Cold start는 질문이고 확신이 아니다.** 초기에 다양성을 확보하되, 사용자 선택을
  명시적 계약으로 취급해 반복 노출을 억제한다.
- **개인화 상태와 개인 원문을 분리한다.** 로컬 daemon이라도 추천 모델에 필요한
  최소 통계만 별도 저장해야 삭제·진단·향후 동기화의 경계가 선명하다.
- **펌웨어는 정책이 아닌 고정 메모리 소비자다.** 추천 후보 생성과 학습은 daemon에,
  byte cap·UTF-8 경계·오프라인 Outbox 내구성은 C3에 둔다.

### 검증
- `pnpm vitest run bridge/src/__tests__/pocket-autonomy.test.ts bridge/src/__tests__/card-modules.test.ts bridge/src/__tests__/card-feed.test.ts` — 64 tests 통과
- `pnpm --filter @agentdeck/bridge typecheck` — 통과
- XTeink: `/opt/homebrew/bin/pio run -e default` — 성공, RAM 126,580 / 327,680
  (38.6%), DRAM static 193,597 bytes (60.26%, 127,699 bytes 여유)

---
