# 2026-07-29 — IPS10 hold-to-talk 결과 표시의 cross-core LVGL crash 제거

터치 복구 펌웨어에서 처음 성공한 hold-to-talk가 끝난 직후 재부팅된 현상을
실기 crash dump와 같은 빌드의 ELF로 역추적했다. 2026-07-29 07:18 KST의
스택은 `Protocol::parseMessage()` → `HUD::notify()` →
`HUD::voiceBannerShow()` → `lv_label_set_text()` → `lv_obj_invalidate()`로
이어졌다. 즉 마이크 I2S/DMA나 heap 고갈이 아니라, `CORE_NETWORK`에서 받은
`voice_result`가 LVGL을 직접 호출한 cross-core 위반이었다.

voice UI 진입점은 이제 LVGL을 만지지 않고 고정 크기 128바이트 latest-state
슬롯에 명령을 게시한다. `HUD::update()`의 `voiceTick()`만 이 상태를 소비해
`CORE_UI`에서 배너를 갱신한다. device-lifetime 경로에 queue나 동적 할당을
추가하지 않았고, 짧은 `portMUX` 임계 구역으로 슬롯만 교체한다.

`/opt/homebrew/bin/pio run -e ips10` 성공(RAM 29.2%, Flash 65.6%) 후
build epoch `1785279533` 펌웨어를 `/dev/cu.wchusbserial31150`에 USB
플래시하고 hash verification을 마쳤다. 직전 crash와 같은 error
`voice_result`를 실기에 재주입했을 때 `[VoiceUI] apply op=3 on core 1`을
확인했으며, 118초 뒤에도 `resetReason=poweron`인 채 재부팅 없이 응답했다.
사용자가 실기 터치 동작도 확인했다. 수정 후 음성을 포함한 전체 PTT 왕복은
운영 사용에서 한 번 더 확인하면 된다.

---
