# 2026-06-29 — IPS10 USB-only reboot root cause: HUD stack smash, not WiFi/daemon half-open

### 문제
10.1" IPS(`ips_10`, `/dev/cu.wchusbserial211240`)가 같은 전원/USB 환경에서도 몇 초 간격으로 재부팅했고, 데몬에서는 한때 포트가 열려 있으나 세션/크리처 데이터가 보이지 않는 것처럼 관찰됐다. 초기 판단은 P4+C6 WiFi/ESP-Hosted half-open 쪽으로 기울었지만, USB-only에서도 재부팅된다는 사용자 관찰과 직접 serial monitor 로그가 그 진단을 반박했다.

### 실제 원인
직접 `pio device monitor`로 데몬을 배제하고 본 로그는 `Stack smashing protect failure!` + `rst:0xc (SW_CPU_RESET)`였다. addr2line 기준 app frame은 `HUD::update()` / `Office::update(float)`였고, stack 내용에는 `crosspoint-agentdeck`, `claude-code`, `OpenClaw` 등 live session 문자열이 남아 있었다.

근본 버그는 `esp32/src/ui/widgets/hud_bar.cpp::HUD::update()`의 legacy session-list buffer였다. IPS10은 `lblSessions == nullptr`이고 D1 mosaic을 쓰는데도 매 프레임 `char buf[400]`에 최대 10개 세션명을 조립했다. 게다가 `pos += snprintf(...)`는 실제로 쓴 길이가 아니라 "썼을 길이"를 반환하므로, 긴 project/session name 조합에서 `pos > sizeof(buf)`가 되고 다음 `buf + pos` / `sizeof(buf) - pos`가 stack 밖 주소와 size_t underflow로 이어졌다. 결과는 UI task stack smash → SW reset. 즉 전원, 배터리, WiFi, C6 coprocessor, office 렌더 자체 문제가 아니라 host 세션 데이터가 충분히 들어온 뒤 HUD text formatting이 stack을 부순 것이다.

### 해결
- IPS10에서는 legacy session-list copy와 `char buf[400]` 조립을 compile-out했다. IPS10은 D1 mosaic 경로가 세션 표시의 소유자다.
- non-IPS legacy HUD도 같은 패턴에 취약했으므로 `appendBounded()` helper로 `snprintf` 반환값을 clamp하고, `pos`가 버퍼 끝을 절대 넘지 않게 했다.
- render loop에 heap allocation은 추가하지 않았다. PSRAM 보드/무-PSRAM 보드 모두 고정 stack buffer + bounded append 경로다.

### 검증
- `pio run -d esp32 -e ips10` 성공.
- `pio run -d esp32 -e ttgo` 성공(non-IPS legacy HUD compile path 확인).
- HUD stack-smash fix를 IPS10 실기에 플래시한 뒤 `/health` 60초+ 샘플에서 `connected=true`, `transportOpen=true`, `stale=false`, read/write 0-4초 유지. 이후 office dead-code cleanup은 위 두 보드 빌드로 검증했다.

### 왜 Claude Code가 헤맸는가
1. `/status`/`sessions_list`/`/devices`의 의미를 섞었다. `/status allSessions: []`를 세션 부재로 과해석했고, `/devices`의 `ips_10` live state와 WebSocket `sessions_list` 10개를 같은 타임라인으로 맞춰 보지 않았다.
2. 포트가 열려 있는데 UI 데이터가 안 보이는 현상을 "half-open"으로 이름 붙인 뒤, 그 가설을 panic log로 검증하지 않았다. ESP32 재부팅/크래시 의심 시에는 daemon health보다 direct serial monitor의 panic line이 1차 증거다.
3. P4+C6 WiFi hang이라는 알려진 문제를 너무 빨리 적용했다. `wifiConfigured:false`는 USB serial 운영에서 정상일 수 있고, USB-only reboot는 WiFi 브링업 hang 가설과 맞지 않는다.
4. `snprintf` 반환값 semantics를 놓쳤다. C/C++ firmware에서 `pos += snprintf(buf + pos, size - pos, ...)`는 `pos < size` guard 없이 쓰면 overflow 방어가 아니라 overflow 트리거가 된다.

Memory tags: `ips10-hud-stack-smash`, `serial-half-open-requires-panic-log`, `snprintf-return-value-not-written-length`.
