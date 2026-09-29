# 2026-08-26 — Pocket pull-OTA는 먼저 발견하고, 끊겨도 이어 받고, 설치 뒤 스스로 stage를 닫는다

Pocket/XTeink의 약한 링크에서 full Feed를 받은 뒤 OTA를 발견하면 첫 요청 자체가 실패할
수 있었고, 기존 클라이언트는 wake 한 번에 여섯 번만 GET하므로 128 KiB 고정 segment로는
큰 이미지를 충분히 전진시키지 못했다. dual-homed Mac에서는 요청을 받은 인터페이스와
device subnet 쪽 반환 경로가 달라 응답이 유실되는 실측 사례도 있었다.

- staged firmware가 있으면 RSSI와 무관하게 full Feed를 cache-preserving `unchanged`
  envelope로 줄여 OTA advert를 먼저 전달한다. 이미 conditional인 Feed는 건드리지 않는다.
- legacy 기본 segment를 256 KiB로 올리고, foreground 클라이언트는 `limit`으로 32–512 KiB
  범위의 cooperative response를 요청할 수 있다. resume offset은 계속 `from`이다.
- Surface Feed GET, Glance Frame, pull OTA는 dual-homed host에서 device subnet 쪽 로컬
  주소로 한 번 307 redirect한다. 오래된 클라이언트를 위해 Outbox POST는 redirect하지 않는다.
- Pocket 이미지의 내장 `CrossPoint version`과 다음 Feed의 client version이 같으면 설치를
  확인하고 persisted stage를 제거한다. 단, stage 파일의 size/MD5/version을 먼저 다시
  계산하므로 같은 경로에 새 바이너리가 생긴 경우 완료로 오인해 버리지 않는다.

검증: pull-OTA/Card Feed 회귀 테스트 61개, 전체 Vitest와 TypeScript build,
Markdown 문서 검사 통과.

---
