# 2026-09-12 — npm 1.3.1 릴리스가 빨갔지만 퍼블리시는 끝나 있었다

`npm-v1.3.1` 태그의 `npm Release` 워크플로(run 34699456625) 1차 시도가 `Publish packages`
단계에서 exit 1 로 끝났다. 로그를 읽으면 실패 지점은 publish 가 아니다. 네 패키지는
14:31:26Z 부터 25초 안에 `shared → hooks → bridge → setup` 순서로 전부 올라갔고, 그 뒤
`scripts/publish-npm.mjs` 의 읽기 확인이 `@agentdeck/shared@1.3.1` 을 60초(5초 × 12회) 동안
`npm view` 로 보지 못해 `registry verification failed` 를 냈다. 다른 세 패키지는 확인 순서상
아직 차례가 오지 않았다.

이 창은 1.0.18 때 `setup` 이 publish 1.5초 뒤 확인에서 안 보였던 사례를 근거로 잡은 값이다.
이번엔 **가장 먼저 올린 패키지가 publish 시작 뒤 84초의 마지막 확인에서도 안 보였다.** npm 의 쓰기 엔드포인트가
publish 를 승인한 뒤 읽기 엔드포인트에 반영되는 지연이 그만큼 길어질 수 있다는 실측이다.

## 조치

실패한 잡을 **재실행**했다(2차 시도 14:33:29Z 시작). `publish-npm.mjs` 는 레지스트리에 이미
있는 정확한 버전을 `already published; skipping` 으로 건너뛰므로, 2차 시도는 publish 없이
네 버전을 읽어 확인하고 notes 렌더와 GitHub Release `AgentDeck npm v1.3.1` 생성까지
14:35:04Z 에 마쳤다. `npm view` 로 네 패키지의 `latest` 가 1.3.1 인 것을 별도로 읽었다.

⚠️ 워크플로 빨간불만 보고 "퍼블리시 실패" 로 읽으면 안 된다. 태그를 지우고 다시 올리거나
버전을 올리는 것은 오답이다 — 버전은 이미 레지스트리에 불변으로 있고, 재태그는 publish 시도가
되어 첫 게이트에서 막힌다([RELEASING.md § A release has five states](RELEASING.md)).
실패한 잡의 재실행이 정확한 절차이며 그대로 [RELEASING.md § npm](RELEASING.md) 5단계에
적었다.

## 60초 창을 그대로 둔 이유와 바꾸는 조건

창을 넓히면 진짜 인증·권한 실패도 그만큼 늦게 빨개진다. 재실행 경로가 이미 무손실로 동작했고
발생은 한 번이므로 값은 그대로 둔다. **같은 실패가 다시 나거나 재실행마저 창 안에 못 보면**
`scripts/npm-registry-visibility.mjs` 의 `attempts`·`intervalMs` 를 올리고 이 항목을 갱신한다.

## 같은 날 OpenClaw 쪽 운영 기록의 오귀인

OpenClaw 운영 문서가 전역 설치 뒤 `node-pty` `spawn-helper` 의 0644 를 "`npm i -g` 가
postinstall 을 막아서" 로 적었는데, 그 원인 귀인은 틀렸다. 퍼블리시된 `@agentdeck/bridge` 에는
postinstall 이 없고, 0644 는 상류 `node-pty@1.1.0` tarball 자체의 모드다. 이미
[2026-08-31 #279](docs/devlog/entries/2026-08-31-04-npm-soak-node-pty-1-1-0-0644-spawn-helper-279.md) 에 규명돼
`PtyManager` 가 첫 spawn 전에 실행 비트를 더하며, 1.3.1 설치본 `dist/pty-manager.js` 에 그 경로가
들어 있다. 이 저장소에 새로 적을 것은 없고 OpenClaw 쪽 문서를 고쳤다.
