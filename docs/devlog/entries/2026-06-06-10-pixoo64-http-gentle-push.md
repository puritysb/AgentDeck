# 2026-06-06 — Pixoo64 HTTP 서버 재부팅 방지용 gentle push 프로파일

### 문제

AgentDeck 재시작 후에도 Pixoo64 가 순간적으로 기본 화면으로 튀고, 이후 기기가 재부팅되는 듯한 현상이 반복됐다. 로그상 `Draw/SendHttpGif` 단일 프레임 push 가 `picId=61` 부근부터 `NSURLErrorDomain Code=-1001` timeout 으로 연속 실패했고, 복구 직후 `GetHttpGifId` 가 `1` 로 동기화됐다. 이는 네트워크 한 번의 흔들림이 아니라 Pixoo 기기 내장 HTTP/GIF 상태가 실제로 리셋됐다는 신호다.

### 원인

이전 안정화는 `PicNum=1` 로 payload 크기를 줄였지만, 상태 변화가 있으면 1.5초 heartbeat 를 우회해 즉시 push 했다. 앱 시작 직후 OpenClaw 연결, Codex App 관찰, sessions_list 변화가 몇 초 안에 연속 발생하면서 Pixoo HTTP 서버에 16KB급 JSON POST 가 짧은 간격으로 여러 번 들어갔다. 실패 후에도 기존 circuit breaker 는 6회 timeout 까지 계속 push 를 시도해, 이미 멈춘 HTTP 서버를 추가로 압박했다. 또한 timeout 된 PicID 를 성공처럼 캐시에 남겨 다음 push 가 PicID gap 을 만들 수 있었다.

### 수정

- Swift `PixooModule` 에 gentle profile 적용:
  - 상태 변화 push 도 최소 12초 간격으로 coalesce.
  - steady heartbeat 는 60초로 완화.
  - `Channel/SetIndex` reassert 는 30초 → 300초.
  - push timeout 은 5초 → 3초.
  - 첫 push timeout 부터 즉시 backoff/probe 로 전환 (`backoffThreshold=1`, initial 30초, max 300초).
- push 실패 시 해당 기기의 cached PicID / last frame / last push time 을 제거해 다음 성공 경로에서 `GetHttpGifId` 로 재동기화한다.

### 검증

- `xcodebuild build -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/AgentDeckDerivedDataPixooGentle CODE_SIGNING_ALLOWED=NO`

---
