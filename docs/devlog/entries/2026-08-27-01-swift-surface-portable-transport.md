# 2026-08-27 — Swift 데몬이 Surface portable transport를 단독으로 완결한다

macOS App Store 앱의 in-process 데몬은 Surface identity를 파싱했지만
`feed.pull`/`feed.conditional`/`glance.read`만 허용해, Outbox와 pull OTA가 필요한
리더는 결국 Node 데몬을 별도로 실행해야 했다. 이 상태는 “단독 Swift 데몬”이라는 제품
경계와 맞지 않았다.

- Swift 협상기를 네 public profile로 확장하고, 협상된 WS 연결은 outbound event와
  inbound command를 capability 기준으로 모두 fail-closed 처리한다. Legacy 연결은 변경하지
  않는다.
- portable Feed에 bounded THREAD/weather projection, idempotent Outbox, pull telemetry를
  연결했다. Inbox는 두 데몬 모두 계속 미구현/미허용이다.
- staged firmware를 App Container로 복사해 product+board+channel namespace로 영속화하고,
  32–512 KiB segment, negotiated 206, MD5, 재시작 복구, embedded-version install ack를
  지원한다. 임의 CLI 경로를 sandbox에서 다시 여는 방식은 쓰지 않는다.
- CLI가 sandboxed Swift 데몬에 stage할 때 `firmware_unreadable`을 받으면 stage/identity를
  보존한 채 base64로 재전송하도록 고쳤다. 기존 코드는 stage 분기에서 즉시 실패했다.
- App Store feature matrix의 Tier 1 Surface 행을 Yes로 올렸고, Swift XCTest가 profile,
  capability, product tuple, persistent/resumable OTA와 install ack를 직접 고정한다.

버전: substantial backward-compatible macOS 기능이므로 Apple `1.1.0`.

검증: `SwiftSurfaceProtocolTests` 9/9, 전체 macOS XCTest 692개(환경 의존 2 skip),
Vitest 3,606개, workspace build/typecheck, 변경 TypeScript lint, docs/design-system,
버전 동기화, App Store 메타데이터·스크린샷·프리뷰 검증이 통과했다. 로컬 Release
archive는 배포 private key 부재와 설치된 macOS profile의 WeatherKit capability 누락을
정확히 보고했고, 로컬 스크립트가 수동 서명 프로젝트에 Automatic을 덮어쓰던 설정은 CI와
같은 Manual/profile 방식으로 정렬했다. 최종 signed archive/verifier는 조직 자격을 가진
GitHub release runner에서 수행한다.
