# 2026-07-27 — Companion Knob ↔ Focus Strip 연동 + 가독성/알림 보완

새 보드의 기능은 많아졌지만 폼팩터의 강점이 UI에 완전히 연결되지는
않아 있었다. Knob 문서의 `focus_session`은 실제 펌웨어가 보내지 않았고,
Focus Strip은 daemon의 `focusedSessionId`를 보관하지 않아 두 기기가
같은 세션을 가리킬 수 없었다. 이제 Knob에서 세션 진입 시 focus를
전송하고, ESP32 공용 상태가 focus를 수신한다. Strip 선택 순서는
**awaiting → explicit focus → processing → roster**이며 Sessions 페이지에도
focus rail을 표시한다. 외부 focus는 Knob list carousel을 한 번만 맞춰
사용자의 이후 회전을 방해하지 않는다.

가독성은 정보량을 줄이는 쪽으로 고쳤다. T-Embed는 16px 한글 fallback을
싣고 본문/질문/메뉴/History를 16px로 올렸으며, detail 메뉴는 4×20px에서
3×27px 행으로 바꿨다. S3-Pro는 22px 헤더와 12px 5행 roster를 버리고
28px 헤더, 16px 본문, 우선순위 3행으로 재구성했다. 수동 페이지 이동은
auto-cycle을 멈추며 헤더가 AUTO/MANUAL을 명시한다.

Pager chime도 aggregate `anyAwaiting` edge에서 세션 ID 집합 edge로 바꿨다.
따라서 A가 계속 기다리는 동안 B가 새로 기다려도 B의 알림이 빠지지
않는다. WS2812의 disconnected 파란 breath는 제거해 amber awaiting만
애니메이션한다. LVGL 재구성의 fragmentation은 60초마다 total/largest
block을 함께 기록해 실기 soak에서 관측 가능하게 했다.

표준 flash helper와 deploy registry에도 `t_embed`/`knob`,
`t_display_pro`/`ticker` alias를 등록했다. Shipping 보드인데도 공용
device-identification 경로에서 unknown environment로 거절되던 운영상
누락을 제거했다.

---
