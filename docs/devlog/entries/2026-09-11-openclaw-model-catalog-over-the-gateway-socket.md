# 2026-09-11 — 모델 카탈로그는 게이트웨이 소켓으로, 실패는 링크가 살아 있는 한 재시도

허브 프레임 수정을 배포하며 데몬을 재시작했더니 OpenClaw 행에 모델이 없고 프레임의 `modelCatalog` 가
0이었다. 접속 시점에 어댑터가 `openclaw models list --json` 을 5초 예산으로 한 번, 10초 뒤 한 번 더
돌리고 그 뒤로는 재접속 때까지 손을 놓는 구조였는데, 그 순간 서브에이전트 둘이 xcodebuild 와 gradle 을
막 띄워 load 가 13~15 였다. CLI 자체는 유휴에서 1.6초, 데몬과 같은 환경으로 실행해도 1.6초 —
문제는 명령이 아니라 **두 번의 5초 창** 이었다. 회복은 데몬을 한 번 더 재시작하는 것뿐이었다
(보드 11대가 한 번 더 끊겼다 붙는 값).

### 판별 지문

행의 `modelName` 과 프레임의 `modelCatalog` 는 같은 함수(`emitModelCatalog`)에서 함께 나간다.
재시작 직후 둘 다 없으면 CLI 호출이 실패한 것이고, 카탈로그만 없고 modelName 은 있으면 metadata
경로 쪽 고장이다. 이번엔 전자였고, 덕분에 허브 프레임 수정(같은 커밋에 있던 metadata 핸들러 교체)이
범인이 아님을 로그 없이도 가릴 수 있었다.

### 수정

Swift 어댑터는 처음부터 게이트웨이의 `models.list` RPC 로 카탈로그를 읽었다 — 이미 쥐고 있는
소켓이라 서브프로세스도 PATH 도 부하 민감성도 없다. Node 를 그 정본에 맞췄다:
`bridge/src/openclaw-model-catalog.ts` 가 Swift `fetchModelCatalog` 의 매핑(key/id/provider 폴백,
tags→role, `missing`→unavailable, 명시적 `defaultModel` 만 기본값으로 인정하고 **순서로 추측하지
않음**)을 미러하고, Node 스위트가 `tests/parity/gateway-frames/models-list-response.json` 을 재생한다
(Swift 패리티 스위트의 `models.list` 케이스는 픽스처 README 의 후속 항목으로 남아 있다).
CLI 는 `models.list` 가 없는 게이트웨이용 폴백으로만 남기되 예산을 15초로 늘렸다.

전송을 바꾸면 두 가지가 달라진다. 라이브 게이트웨이(openclaw 2026.9.3)의 `models.list` 는 모델을
`id` + `provider` 로 따로 보내고(`glm-5.3` + `zai`), CLI 는 합친 `key` 를 보냈다(`zai/glm-5.3`,
로컬 모델도 `local-mlx/mlx-community/…` 처럼 id 에 슬래시가 있어도 provider 를 접두). 파서는 CLI
형식으로 합쳐서 key 에 묶인 것이 전송 변경으로 흔들리지 않게 했고, Swift 도 같은 식으로 맞췄다 —
Swift 는 원래 맨 `id` 를 key 로 써서 `mainSessionModelKey`(`provider/model` 형식) 표시명 조회가
빗나가고 있었다. 그리고 RPC 는 **런타임에 허용된 카탈로그**(15개)만 주고 CLI 는 별칭까지 38개를
줬다 — 이제 Node 도 Swift 와 같은 15개를 보인다. 데크에서 모델 전환은 `/model` 프롬프트라 key 를
쓰지 않는다.

적대적 리뷰가 새 코드에서 경쟁 하나를 찾았다: 링크가 끊기고 1초 만에 재접속하면 새 fetch 가 먼저
성공하는데, 옛 링크에서 시작된 느린 CLI 폴백이 뒤늦게 돌아와 카탈로그를 되돌린다. 양 데몬에
접속·단절마다 오르는 세대 토큰을 두고, fetch 가 시작한 세대와 끝난 세대가 다르면 성공이든 실패든
버린다(Swift 는 actor 재진입이 같은 구멍을 연다). 그리고 핸드셰이크 `features.methods` 에
`models.list` 가 없는 게이트웨이엔 RPC 를 묻지 않고 CLI 로 간다 — 모르는 메서드를 조용히 버리는
빌드라면 재시도 틱마다 RPC 타임아웃 10초를 영원히 물 것이기 때문이다.

재시도는 양 데몬이 같은 사다리를 탄다: 10초, 30초, 60초, 120초, 그 뒤 5분마다, 링크가 끊기거나
어댑터가 멈출 때까지. 첫 실패는 접속 직후 게이트웨이가 바쁜 흔한 일이라 debug 로만, 두 번째부터는
데몬 로그에 남긴다 — 성공할 때까지 어떤 표면에도 모델·카탈로그가 없는 상태이기 때문이다. 회복
시에도 한 줄 남긴다.

관련: [.claude/rules/openclaw-gateway.md](.claude/rules/openclaw-gateway.md),
[2026-09-11 허브 프레임 신원](docs/devlog/entries/2026-09-11-openclaw-frame-identity-and-codex-ambient-hooks.md).
