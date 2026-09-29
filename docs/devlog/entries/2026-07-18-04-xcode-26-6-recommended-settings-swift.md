# 2026-07-18 — Xcode 26.6 recommended settings + Swift 경고 정리

- `apple/project.yml`의 Xcode 정본 버전을 26.4에서 26.6으로 올리고 `xcodegen generate`를 실행했다. 프로젝트와 macOS/iOS scheme의 `LastUpgradeCheck`/`LastUpgradeVersion`이 2660으로 동기화됐으며, App Store 빌드 조건과 의도적인 `ENABLE_USER_SCRIPT_SANDBOXING=NO`는 유지됐다.
- Swift 6/macOS 26 경고를 정리했다: `ApmeCollector`의 같은 MainActor 안 불필요한 `await`, Pixoo/AuthManager의 배열 기반 `String(cString:)`, Timeline/IPS10 preview의 deprecated `Text + Text`를 각각 동기 호출, NUL 절단 UTF-8 decode, styled `Text` interpolation으로 교체했다.
- quicktype이 생성하는 `JSONNull.hashValue`가 프로토콜 재생성 때 되살아나지 않도록 `scripts/patch-quicktype-swift.mjs` 후처리를 추가했다. 세 Swift 산출물에 공통 적용해 `hash(into:)`와 final `JSONCodingKey`를 보장한다.
- 테스트 타깃에서 추가로 드러난 `DevicePreviewSnapshotTests.setUp()` actor 경고는 출력 디렉터리를 MainActor lazy 속성으로 초기화해 제거했다.
- 검증: `pnpm generate-protocol`, `xcodegen generate --spec apple/project.yml`, `AgentDeck_macOS` Debug build 성공. `ApmeTaskBoundaryTests`와 `TimelineTests`도 경고 없이 통과했다.
