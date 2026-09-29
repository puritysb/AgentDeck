# 2026-07-26 — 훅 설치 경로를 `~/.claude/settings.json` 으로 일원화 (+ 미러 4→3)

### 문제
전날 훅 타임아웃 픽스의 "알려진 후속" 2건을 처리했다. 그리고 그 픽스가
**되돌려질 상태**였다 — 실제로 `~/.claude/settings.json` 을 쓰는 주체는
App Store 로 설치된 `/Applications/AgentDeck.app`(1.0.2 / build 3901)이고,
그 바이너리에는 여전히 구버전 커맨드(`curl -sf -X POST ...`, 타임아웃 없음)가
박혀 있다. 컨테이너 prefs 는 `hookInstallConsent=accepted` +
`claudeSettingsPath=~/.claude/settings.json` 이라 다음 실행의
`HookInstaller.installIfNeeded()` 가 그대로 덮어쓴다.

후속 2건:
1. node 설치기 3곳이 전부 `~/.claude/settings.local.json` 에 썼다. Claude Code
   의 `localSettings` 는 git root/cwd 기준이라 **홈 스코프에서는 읽히지 않는
   파일**이다(홈이 프로젝트 루트일 때만 로드 — 그 경우엔 settings.json 과
   중복 발화). CLI 로만 설치한 사용자는 훅이 죽은 파일에 들어갔고, macOS 앱을
   같이 쓰는 환경에서만 우연히 동작했다.
2. `bridge/src/hook-migration.ts` 의 로컬 `buildHookCommand` 에 PreToolUse/Stop
   request-response 분기가 없어, 그 `applyHooks` 가 실효 파일에 돌면 두 훅을
   fire-and-forget 으로 강등시킨다.

### 해결
- **되돌림 차단(스톱갭)**: 로컬 교체 대신 앱의 훅 동의만 껐다 —
  `defaults write <컨테이너 prefs> prefs.hookInstallConsent declined` →
  `installIfNeeded()` 가 즉시 return. settings.json 보존, MAS 자동업데이트
  링크 유지. 정식 복구는 픽스가 들어간 다음 App Store 릴리스에서.
  (로컬 Development 서명 빌드로 /Applications 를 덮으면 MAS 업데이트 경로가
  끊기고 다음 스토어 업데이트가 다시 구버전을 되돌린다 — 그래서 기각.)
- **(1) 경로 일원화**: `hooks/src/install.ts` 에 `claudeSettingsPaths()` /
  `sweepLegacyHooks()` 를 추가하고 install/uninstall/migrate 를 전부
  `settings.json` 기준으로 바꿨다. `migrateHooksIfNeeded()` 는 레거시 파일에
  남은 훅을 **정본 빌더로 재생성해 settings.json 으로 이전**하고 레거시에서
  제거한다(= 이전 사용자는 마이그레이션만으로 bounded 커맨드까지 획득).
  `setup/src/setup.ts` 는 워크스페이스 의존이 없어야 하므로 sweep 을 인라인
  복제. FS 래퍼들은 `home` 인자를 받게 해서 tmpdir 로 테스트 가능하게 했다.
- **(2) 중복 제거**: `bridge/src/hook-migration.ts` **삭제**, `bridge/src/index.ts`
  가 `@agentdeck/hooks` 의 `migrateHooksIfNeeded` 를 직접 쓴다. 미러는 4곳 →
  **3곳**(hooks 정본 / setup 인라인 / Swift). CLAUDE.md 불변식도 갱신.
- **(3) Migration 7 — unbounded curl 자가치유**: 1.0.x 혼용 점검에서 구멍이
  나왔다. 구버전 App Store 앱이 쓴 `settings.json`(daemon.json 조회 O,
  Stop request-response O, PostToolUseFailure O — **타임아웃만 없음**)은
  마이그레이션 1~6 조건에 하나도 안 걸려 **8개 중 0개 수리**됐다(실측).
  `hasUnboundedHookCurl()` 을 추가해 fire-and-forget POST 에 `--max-time` 이
  없거나 `/health` 프로브에 `--connect-timeout` 이 없으면 전면 재생성한다 →
  같은 픽스처로 **6/6 복구** 확인. PreToolUse/Stop 은 설계상 롱 타임아웃이라
  제외, Windows PowerShell 폼은 `-TimeoutSec` 로 이미 bounded 라 매칭 대상
  아님. 라이브 `settings.json` 사본에 돌려 무변경(idempotent)도 확인.

검증: `pnpm build` green, `vitest run` 112 files / 1905 tests green(신규 5개 —
설치 대상 파일, 레거시 sweep 시 사용자 키 보존, 이전, 우리 훅이 없는
settings.json 무변경, 양쪽 uninstall). 실사용 파일로도 확인 — 라이브
settings.json 사본에 마이그레이션을 돌려 **byte-identical**(체크섬 불변),
중복 상태로 남아 있던 `~/.claude/settings.local.json` 의 훅 8종은 sweep 해서
`{}` 로 정리.

### 핵심 설계 결정
- **"어느 파일이 읽히는가"는 스코프 함수다.** `settings.local.json` 은 이름만
  보면 유저 로컬 오버라이드 같지만 Claude Code 에서 local = **프로젝트** 로컬
  이다. 홈에 같은 이름을 두면 "대부분의 사용자에겐 죽은 파일, 홈에서 세션을
  연 사용자에겐 중복 발화"라는 최악의 조합이 된다. Swift 가 먼저 옮겨간 곳으로
  node 도 따라간 이유.
- 마이그레이션은 레거시 엔트리를 **복사하지 않고 재생성**한다. 옛 파일에 있던
  커맨드는 정의상 낡았으므로(타임아웃 없음 등) 그대로 옮기면 낡은 상태가
  연장될 뿐이다.
- **마이그레이션 조건은 "무엇이 바뀌었나"가 아니라 "무엇이 틀렸나"로 쓴다.**
  1~6 은 전부 특정 릴리스의 변경점을 추적하는 조건이었고, 그래서 "우리가
  아는 모든 기능은 갖췄지만 타임아웃만 없는" 조합을 통과시켰다. 7 은 결함
  자체(`--max-time` 부재)를 본다. 파일을 **공동 소유**하는 주체(구버전 앱)가
  있는 한, 설치기는 자기가 쓴 결과가 남아 있다고 가정하면 안 된다.
- 중복 구현은 "동기화 주석"으로 못 막는다 — hook-migration.ts 는 주석까지
  달아두고도 분기 하나가 누락돼 있었다. 워크스페이스 의존이 가능한 곳
  (bridge)은 import 로 없애고, 부트스트랩이라 불가능한 곳(setup)만 복제로
  남긴다. 남은 복제는 CLAUDE.md 에 이유와 함께 명시.

---
