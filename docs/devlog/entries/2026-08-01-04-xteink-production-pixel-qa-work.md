# 2026-08-01 — XTeink 글랜스 production-pixel QA + 긴 WORK 행 말줄임

X3/X4 실데이터 `/glance-frame?format=png`를 패널과 동일한 1bpp 픽셀로
재검증했다. 날씨 벡터 아이콘·현재/강수/내일·Claude/Codex 게이지·최근 작업의
계층은 양쪽 해상도에서 유지됐고, X3는 528×792 논리 프레임이
GfxRenderer 공식과 동일한 792×528 물리 공간으로 회전됐다. 이 과정에서 X4의
긴 WORK 행이 clip 경계에서 글자 중간에 갑자기 끊기는 결함을 발견해,
서버 SVG 렌더러가 CJK/full-width와 라틴 폭을 보수적으로 추정하여 clip 전에
말줄임표를 넣도록 수정했다. clipPath는 최종 안전 경계로 유지한다.

검증: glance/weather/card-feed vitest 62 green, bridge `tsc`, 공통 e-ink layout
테스트·XTeink sync drift gate, CrossPoint 호스트 테스트 102 green,
CrossPoint C3 firmware build 성공(RAM 124,340B/37.9%, Flash
5,370,783B/82.0%). `firmware/update.bin` 5,384,064B, SHA-256
`e598b96b772960f144e7b02e6d9dc93b3d52572e77d069e155befbdefd5d9872`.
라이브 연속 요청도 304를 반환했다. X4는 잠시 `16c1674b`로 WS 등록됐지만 OTA
시점 전에 cadence sleep으로 복귀해 `No online WiFi ESP32 target`으로 중단;
X3도 오프라인이라 실기 설치는 다음 물리 wake 창에 남아 있다.

---
