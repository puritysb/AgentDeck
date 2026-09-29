# 2026-08-26 — Codex App의 보존된 채팅과 AgentDeck의 활성 세션을 분리한다

Codex App의 단일 `app-server`는 사용자가 열어 본 여러 채팅의 rollout FD를 며칠씩
유지한다. Node passive observer는 이 FD 하나를 세션 하나로 만들고 모두 `alive: true`로
내보내서, 실제 hook/OTel 활동은 한 스레드뿐이어도 과거 idle 채팅이 기기마다 계속
쌓였다. 같은 raw roster를 Swift daemon은 project별로 접었지만 Node daemon은 그대로
보내고 일부 consumer만 다시 접어, 화면별 세션 수도 서로 달랐다.

- Codex App의 idle rollout은 마지막 write 후 90초까지만 active roster에 남긴다. CLI는
  프로세스 자체가 열린 대화이므로 기존처럼 유지하고, processing rollout도 보존한다.
- Node `BridgeCore`가 enrich 뒤 Codex project folding + 안정 정렬을 수행하고 initial
  connect도 같은 snapshot builder를 사용한다. raw registry는 routing/diagnostics용으로
  그대로 유지한다.
- USB/WiFi 중복 전송은 현재 daemon lifetime에 live `device_info`를 받고 최근 inbound가
  있는 serial만 우선한다. cache-seeded CDC에 write만 성공했다는 이유로 정상 WiFi
  display stream을 막지 않으며, `/devices`에 `deviceInfoFresh`를 노출한다.

검증: 전체 Vitest 3,603개, monorepo build, Markdown 문서 검사와 `git diff --check`
통과.

---
