# 2026-09-04 — T-Embed 차임과 화면이 가리키던 세션을 하나의 waiting 전이로 통합

T-Embed CC1101에서 들린 소리는 I2S 잡음이 아니라 펌웨어의 880→1318.5 Hz **2음 attention
차임**이었다. 당시 권한 승인 요청은 없었지만 다른 Claude 세션에는 실제
`awaiting_option`(AskUserQuestion)이 있었다. 기존 구현은 `main.cpp`에서 모든 세션의
`awaiting*`를 보고 차임을 울리는 반면, knob carousel은 사용자가 돌리기 전 idle OpenClaw를
기본 중앙 카드로 골랐다. 그래서 소리는 실제 대기를 알렸지만 화면은 그 원인을 숨겼다.
게다가 직전 프레임 ID 배열만 기억해 빈 roster/transport reconnect 뒤 같은 미해결 대기를
새 이벤트로 오인할 수 있었다.

대기 edge를 knob UI로 옮기고, 10개 고정 슬롯(360 B, 동적 할당 없음)의 session-ID latch를
추가했다. 대기는 세션별 진입 시 한 번만 차임을 예약하고, roster가 잠시 사라져도 latch를
유지하며, 같은 ID의 non-awaiting 상태를 실제로 관측해야 다시 arm된다. List에서는 차임을
만든 정확한 세션을 ID로 중앙에 두고 roster 순서가 바뀌어도 따라간다. 사용자가 encoder를
돌리면 자동 초점을 명시적으로 해제한다. Detail/scrub 작업 중에는 cursor를 빼앗지 않고
footer로 대기 세션을 알린다. `main.cpp`의 독립적인 이전-frame 차임 검사는 제거해 화면과
소리의 원천을 하나로 만들었다.

검증: 새 tracker host test 통과, T-Embed native simulator build 및 `attention` scene에서
OpenClaw(index 0)가 아니라 Claude waiting(index 1)을 선택하고 roster swap 뒤 ID를 따라
index 0으로 이동하는 회귀 검사 통과, 실제 `t_embed` firmware build 성공(RAM 39.5%, flash
64.7%). `device_info`로 `/dev/cu.usbmodem314401`이 `t_embed`/기존 `3186cff4`임을 확인한 뒤
`190f850d-dirty`를 USB full flash했고 read-back을 확인했다. 실기 serial 주입에서는 동일
waiting 반복 + empty roster + 같은 ID 재등장에 추가 차임 0회, 명시적 idle 뒤 재진입에
`[Speaker] played 8000/8000 bytes`, drop 0으로 차임 1회를 확인했다.

---
