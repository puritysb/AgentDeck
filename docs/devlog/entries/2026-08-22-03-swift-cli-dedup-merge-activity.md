# 2026-08-22 — Swift/CLI 통합 에이전트 활동 기록: 누락 보완, 자동 dedup/merge, Activity 화면

### 목표와 제품 결정

“어느 에이전트를 언제, 얼마나, 어떤 작업에 썼는지”를 별도 분석 도구 없이 한눈에 보이게
하는 기능을 `codex/apme-unified-history` 브랜치에서 구현했다. 대시보드 첫 탭은 에이전트별
작업 수·실행 시간 카드와 최근 작업 표만 보여주고, 기존 Runs/Tasks/Graph/Scorecard는
그대로 둔다. `1.0 → 1.1`은 모든 타깃의 호환성 라인을 함께 바꾸는 의미라 기능 브랜치에서
올리지 않는다. 실제 배포 시 영향 채널만 Apple `1.0.8 → 1.0.9`, npm/CLI
`1.0.22 → 1.0.23` 패치 릴리스 후보로 준비한다.

### 수집과 시간 의미

- Swift 데몬이 `codex_*` / `opencode_*` hook을 agent-neutral APME 경계로 정규화하고,
  Codex rollout/OpenCode inline 응답도 turn에 저장한다. durable source session id가 없으면
  다른 세션과 잘못 합치지 않고 버린다.
- hook이 오지 않는 Kiro CLI는 기존 transcript watermark가 허용한 “첫 발견 시 최신 한 턴,
  이후 새 행”만 양 데몬의 APME로 보낸다. 과거 transcript 전체는 재생하지 않는다.
- turn은 다음 프롬프트가 아니라 Stop에서 닫고 `end_source`를 남긴다. Activity의 시간은
  task 시작~종료 벽시계가 아니라 turn 실행 구간 합이므로 사용자 대기/입력 시간은 제외된다.

### 두 데몬 공존과 병합

Swift와 Node는 각자의 SQLite를 계속 소유한다. 포트 인계 직전 CLI가 Swift projection을
가져오고, 외부 CLI가 살아 있는 동안 Swift가 분당 한 번 CLI projection을 동기화한다.
교환물은 인증된 loopback `/apme/activity`의 최대 500개 파생 행뿐이며 각 데이터 디렉터리의
삭제 가능한 `apme-peer-activity.json`에 저장한다. agent + native session + task index +
정규화 첫 프롬프트로 만든 `activity:v1` key와 5분 이내 시간 접점을 함께 확인해 합친다.
인계 조각도 동일 세션/인덱스와 같은 시간 조건을 모두 만족해야 한다. prompt text만 같거나
애매한 과거 행은 별도로 유지한다.
중복 수치는 합산하지 않고 더 완전한 행의 최대값을 택한다.

### 검증

- TypeScript: `tsc --noEmit`, activity/dashboard/takeover/http/Kiro focused Vitest 47개 통과.
- Apple: `scripts/test-report.sh --apple` — XCTest 650개 통과, 환경 조건부 skip 2
  (snapshot opt-in, 이 Mac의 기존 Kiro bookmark), 실패 0. 테스트 완료 뒤 잠긴 실기기
  notification service를 재시도하던 Xcode 프로세스만 종료했다.
- App Store tier matrix에 구현 전 행을 추가했으며 Swift 경로는 URLSession/CryptoKit/FileManager만
  사용한다. subprocess, helper 실행, 다른 tier DB 접근은 없다.

### 메뉴바 요약 리포트

macOS `MenuBarExtra` 팝업을 약 700pt의 2열 구조로 확장했다. 기존 세션/장치 상태는 왼쪽에
그대로 두고, 오른쪽 Activity pane은 동일한 `/apme/activity` 통합 projection에서 전체 실제
작업시간, 상위 4개 에이전트의 작업시간·작업 수, 최근 작업 3개만 표시한다. 데이터 출처도
Swift / CLI / Swift + CLI로 짧게 알리고 **Full report**가 기존 상세 APME 창을 연다. 팝업이
보이는 동안만 최초 1회 및 30초 저빈도로 URLSession을 사용하며, 실패하면 마지막 정상
snapshot을 유지한다. 별도 DB 접근, subprocess, 추가 수집·중복 제거 구현은 없다.

---
