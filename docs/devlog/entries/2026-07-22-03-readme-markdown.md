# 2026-07-22 — README/내부 문서 정합성 감사 + Markdown 링크 게이트

README 의 D200H direct-HID 다이어그램과 “full bridge” 표현을 현재 2-tier 구조에
맞게 고쳤다. D200H는 Ulanzi Studio plugin이 daemon WS에 연결하는 유일한 경로이며,
App Store Swift daemon은 standalone 모니터링 허브지만 PTY Session Bridge는 아니다.
같은 경계를 `docs/daemon.md`와 Apple 사용자 문서에도 반영해, Swift 단독 실행을
“세션 0개 + CLI 설치 유도”로 설명하던 폐기 문구를 제거했다.

`hardware-compatibility.md` 재구성 후 남아 있던 Android/ESP32의 옛 §A/§D 앵커를
현행 섹션으로 연결했고, TestFlight QA의 D200H 절차를 Ulanzi Studio plugin/WS
presence 기준으로 바꿨다. 출시 태그도 고정 `apple-v1.0.0` 대신
`apple-v<VERSION>`으로 일반화했다. 사용자 매뉴얼 5개의 중복 H1을 정리하고,
Swift daemon 파일/LOC 고정 수치를 없앴으며 개인 `file:///Users/...` 링크를
저장소 상대 링크로 치환했다.

재발 방지로 `pnpm docs:check`를 추가했다. 추적 중이거나 새로 추가된 Markdown
전체의 로컬 파일·이미지 경로와 `.md` 앵커를 검사하고, machine-local/저장소 밖
링크를 거부하며, README 및 `docs/` 문서는 H1 하나만 허용한다. Design System
CI도 이 게이트를 실행한다.

릴리스 형상도 함께 재검증했다. `pnpm test` 110 files / 1,876 tests, 전체
TypeScript typecheck와 production build, Android debug unit tests, macOS XCTest
466개(1 snapshot opt-in skip), iOS XCTest 114개(1 snapshot opt-in skip)가 모두
통과했다. 1.0.1 macOS/iOS를 각각 Release archive·App Store export한 뒤 실제
배포 앱에 `verify-appstore-archive.sh`를 적용해 두 플랫폼 모두 불변식 통과를
확인했고, 제출 패키지의 3개 locale 메타데이터·39개 screenshot·3개 preview
video도 검증했다. TestFlight upload는 ASC 환경 변수를 주입하지 않아 의도적으로
생략했다.

비차단 잔여 진단은 두 건이다. Android 컴파일러가 `SettingsScreen.isEink` 미사용
parameter 경고 1건을 내며, `bash design/lint.sh`는 `.venv`, `apple/DerivedData`,
vendor Ulanzi SDK/시뮬레이터까지 스캔하는 기존 scope 문제로 725건을 보고한다.
둘 다 이번 출시 바이너리·문서 수정의 실패는 아니지만 별도 정리 대상으로 남긴다.

> **Older entries are archived by month** under [`docs/devlog/`](docs/devlog/README.md). This active file keeps the current month plus the preceding month (currently 2026-07 and 2026-06); search only the relevant monthly archive for older history.
