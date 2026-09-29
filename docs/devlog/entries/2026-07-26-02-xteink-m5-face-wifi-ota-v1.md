# 2026-07-26 — XTeink M5 Face 셸 + WiFi OTA v1 클라이언트 (실기 검증 완료)

### 문제
(1) 포크 UX가 "연결이 전경, 콘텐츠가 배경" — 데몬이 몇 분 내려가자 기기가
Connecting… 벽돌이 됐다(전날 필드 리포트). (2) 펌웨어 배포가 SD/File
Transfer 수동 경로뿐이라 반복 개발이 느렸다.

### 해결
포크 커밋 3개: 582370ed **M5 Face 셸**(모든 연결 상태에서 Face 렌더, WiFi
조인/탐색/연결은 상태줄로 강등, 저장된 자격증명은 백그라운드 STA 조인,
`startupApp` boot-to-card 설정 + 부팅 중 Back 홀드=리더 홈 탈출구),
8dfbb97f **WiFi OTA v1 클라이언트**, 88aaf098 문서 노트. OTA는 AgentDeck
쪽 수정 0으로 성립 — 데몬은 `device_info.otaSupported`로만 게이트하고
CLI는 미지 타깃을 그대로 통과시킨다(`agentdeck esp32-ota xteink_x4
--firmware <bin>`). 실기 검증: X4 buildHash 8dfbb97f→88aaf098 flip,
end-ack→재등록 41초(boot-to-card 자동 복귀); X3 동일 빌드 확인. AgentDeck
문서 갱신 cb972a09(하드웨어 매트릭스 + 스펙카드 sync + client-contract).

### 핵심 설계 결정
- **X4는 Arduino `Update` 클래스 금지** — `esp_image_verify`가 패치 이미지를
  거부한다. OTA 청크를 SD 캐시로 스트리밍 → MD5+구조 검증 → end-ack(데몬
  30초 예산 내) → raw-partition 플래시+otadata 스위치. 실패해도 현행
  펌웨어 부팅 가능.
- OTA 프레임은 포크의 **필터 파서 앞단에서 소비** — ArduinoJson 필터가
  base64 `data`를 조용히 떨어뜨리는 함정 회피.
- **로스터 부재 ≠ 재부팅 증거**: 데몬은 OTA 성공 시 해당 보드 로스터를
  지우고, 기기 WS가 살아 있으면 재등록 이벤트가 없다. 진단은 buildHash로.
- boot-to-card가 OTA 루프를 닫는다: 재부팅 후 자동으로 대시보드 복귀.
  미해결: X4 1차 푸시는 전송·검증 성공 후 플래시 미반영(2차 성공, 원인
  미확정 — SD `agentdeck.log`의 `error stage=flash` 줄로 확정 가능).
- 게이트 운영 교훈: `pnpm design-system:check | tail`은 파이프가 exit code를
  삼킨다 — 게이트는 파이프 없이 실행하고, canonical 문서의 `revision` 범프는
  ko/ja locale `source_revision` 핀을 같은 커밋에서 함께 올려야 한다.

---
