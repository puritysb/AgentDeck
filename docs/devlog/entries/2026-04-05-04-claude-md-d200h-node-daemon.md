# 2026-04-05 — CLAUDE.md 재구성 + D200H Node daemon 활성화

### 문제
재부팅 후 LaunchAgent(`dev.agentdeck.daemon`)가 Node.js CLI daemon을 자동 실행했는데 D200H 화면이 안 나오고 Round AMOLED도 이상. 원인은 Node daemon이 D200H를 아예 지원하지 않아서 (`modules/index.ts`에서 `new D200hModule()`이 주석 처리되고 "Swift daemon only" 주석이 붙어있었음). Round는 WiFi provision만 반복 실패. 부가적으로 CLAUDE.md가 41.5KB/303줄까지 비대해져서 Claude Code 성능 경고 발생 (40KB 한도 초과).

### 해결
**1. CLAUDE.md 재구성** (commit e382864): "Key Design Decisions"가 24KB(58%)로 비대. 주제별로 7개 신규 `docs/*.md`에 **원문 그대로** 이식 + voice-setup.md 확장. CLAUDE.md는 9.8KB/169줄 인덱스로 축소 (76% 감소). 역할 분리 원칙 재확인 — CLAUDE.md=팀 아키텍처 인덱스, docs/=상세 기술 문서, memory/=개인 gotchas.

**2. Daemon LaunchAgent 제거**: `agentdeck daemon uninstall` + 실행 중 Node daemon stop. macOS 앱 TestFlight 배포 전까지 수동 실행 모드. 앱 배포 시 `DaemonService`가 in-process Swift daemon 자동 기동하므로 LaunchAgent 재등록 불필요.

**3. D200H Node daemon 활성화** (commit 27765c7): 기존 `bridge/src/modules/d200h-module.ts` (292줄) + `bridge/src/d200h/hid-protocol.ts` + `image-renderer.ts` 코드는 이미 완전히 존재. 3파일만 수정:
- `modules/index.ts`: `createDefaultModules()`에 `new D200hModule()` 추가
- `daemon-server.ts`: daemon 모듈 configs에 `d200h: 'auto'` 명시
- `cli.ts`: 4개 session 커맨드(claude/codex/opencode/monitor + --local)에 `d200h: false` 명시

물리 디바이스로 검증 (serial 02C35A044U3670684): Consumer Control 인터페이스 연결 → 첫 프레임 10100 bytes/10 packets 전송 성공. Keyboard 인터페이스는 macOS IOKit 제한으로 열지 못하지만 D200H는 Consumer로도 버튼 이벤트 수신 가능해서 문제 없음.

### 핵심 설계 결정
**Daemon-only 디바이스 모듈의 session bridge 격리 원칙**: `ModuleConfigs`의 d200h 기본값이 `'auto'`이기 때문에 세션 커맨드에서도 명시하지 않으면 자동 활성화돼버려 HID 디바이스 다중 오픈 충돌 발생. serial/pixoo/mdns와 같은 패턴으로 **세션 커맨드에서 반드시 `d200h: false` 명시 필요**. 기존 mdns(false)/serial(false)/pixoo(false)와 동일한 "daemon이 단일 hub" 보장 규칙.

**듀얼 구현체 유지 정책**: Swift daemon(1772줄, v4 멀티세션 UI, 15s heartbeat, 13 sessions/page) + Node.js daemon(v3-era 14-key static layout, 30s keep-alive) 병행. macOS 앱 없는 환경에서도 CLI로 D200H 기본 동작 보장. Swift는 기능 우위지만 macOS 한정. 이 결정은 `docs/plugin-conventions.md` "Two implementations (daemon-only)" 섹션에 명시.

---
