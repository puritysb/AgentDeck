# 2026-03-29 — macOS 앱 세션 실행 fallback 정리

### 문제
메뉴바의 `Launch Claude Session`이 여전히 `agentdeck claude` 전용 경로에 묶여 있어, Swift native daemon을 앱에 통합한 뒤에도 Claude Code CLI만 설치된 환경에서는 앱에서 세션 시작이 불가능했음. 이는 "App Store 단일 앱 + hooks 기반 80/20 전략"과 어긋남.

### 해결
- `SessionLauncher.swift`에 실행 계획 해석 로직(`resolveLaunchPlan`) 추가
- 우선순위를 `installed bridge` → `bundled bridge` → `plain claude`로 정리
- plain `claude` 실행에도 현재 daemon 포트를 `AGENTDECK_PORT`로 주입하도록 변경
- 프로젝트 경로가 있으면 `cd <project> && ...` 형태로 시작하도록 정리
- macOS 단위 테스트 `SessionLauncherTests.swift` 추가

### 핵심 설계 결정
- **Bridge는 옵션, Claude CLI는 필수**: Bridge가 없어도 hooks 기반 모니터링/권한 응답이 가능하므로, 런처는 plain `claude`를 1급 경로로 지원해야 함
- **포트는 런처에서 명시 전달**: plain `claude`는 기본적으로 `AGENTDECK_PORT`를 모르므로, 메뉴바 런치 시 앱 daemon 포트를 명시해 hook 타깃을 고정
- **실행 선택 로직은 순수 함수화**: AppKit/Terminal 실행과 분리해 테스트 가능하게 만듦

---
