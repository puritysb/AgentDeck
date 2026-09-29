# 2026-06-06 — Swift Pixoo64 default 화면 순간 전환 완화

### 문제

Swift daemon 의 Pixoo64 push 는 단일 프레임/1.5초 heartbeat 로 안정화됐지만, 실기기에서 순간적으로 Pixoo 기본 Custom/default 화면으로 전환되는 현상이 남았다. 로그상 HTTP push 자체는 `error_code=0` 으로 회복되고 있었고, 튐은 특히 backed-off 복구 후 `Channel/SetIndex`/`SetBrightness`/`GetHttpGifId` 재준비와 정기 Custom 채널 재확인 구간에서 발생할 수 있었다.

### 원인

`Channel/SetIndex` 는 Pixoo 를 Custom 채널로 되돌리지만, 바로 `Draw/SendHttpGif` 를 이어서 보내지 않으면 펌웨어가 Custom 채널의 내장 기본 화면을 잠깐 노출할 수 있다. Swift `PixooModule.reassertChannels()` 는 30초마다 `Channel/SetIndex` 만 전송했고, normal push 경로는 동일 프레임 5초 skip 을 적용하므로 기본 화면이 다음 강제 push 까지 보일 수 있었다. 복구 경로도 probe 성공 직후 `prepareDevice()` 로 채널을 먼저 바꾼 뒤 2초 grace 를 기다려 같은 노출 창을 만들었다.

### 수정

- `probeBackedOffDevices()` 는 probe 성공 뒤 2초 동안 기기를 건드리지 않고 안정화한 다음 `prepareDevice()` 와 현재 프레임 강제 seed 를 연속 실행하도록 변경했다.
- `reassertChannels()` 는 actor-level `isPushing` guard 를 공유하고, `Channel/SetIndex` 직후 현재 Pixoo 프레임을 `force=true` 로 다시 전송한다.
- `pushSequenceToDevice()` 에 force 옵션을 추가해 channel reassert/recovery seed 는 동일 프레임 5초 skip 을 우회한다.
- Pixoo API 응답의 `error_code` / `errorCode` 가 0 이 아닌 경우 HTTP 성공이어도 push 실패로 기록한다.

### 대안

정기 `Channel/SetIndex` 를 완전히 제거하면 default 화면 노출 가능성은 더 낮아지지만, brownout/펌웨어 drift 후 Custom 채널 자동 복구가 느려진다. 현재 선택은 재확인을 유지하되 재확인 직후 프레임을 즉시 재시드하는 절충안이다.

---
