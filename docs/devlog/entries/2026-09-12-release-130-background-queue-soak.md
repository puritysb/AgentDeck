# 2026-09-12 — 1.3.0 제출과 npm 인계 검증의 background queue 보완

릴리스 준비 PR #313을 검토하고 iOS 전용 컴파일 오류, 촬영 설정의 호스트 잔류,
합성 collaboration timestamp 단위를 수정했다. 새 iPhone 14 Plus 시뮬레이터로
스크린샷과 프리뷰를 교체했다. 배포 기준 커밋은
`04233b7223ede3c8f40ba2bcde9a0500828ea4e5`다. #314가 채널별 전달 기록을 소유한다.

- Apple iOS/macOS 1.3.0(6601)은 distribution-signed export gate를 통과하고
  App Store Connect `WAITING_FOR_REVIEW`까지 확인했다. 3개 언어의 미디어 48개는
  처리 완료 및 커밋된 원본과 MD5 일치를 확인했다.
- Play 1.3.0(16)은 production 심사 전송, Elgato 1.3.0.0은 공식 CI 산출물로
  `Pending review`다. Elgato 자동 공개는 껐으며 DRM 처리본 검증 전 공개하지 않는다.
- ESP32는 배포 파일명과 보고 식별자가 바뀌므로 건너뛰지 않고 1.2.3 patch로 컷했다.
  TRMNL은 `trmnl_75`, 기존 `inkdeck`은 데몬의 호환 별칭으로 남는다.

## 실제 설치 경로에서의 검증

최종 커밋을 빌드하고 npm 4개 tarball을 실제 PATH의 `agentdeck`으로 설치했다.
기존 pnpm shim과 1.2.1(6301) 앱은 백업했다. Node 26.5/ABI 147에서 native SQLite
로드를 확인했다. CLI 단독으로 직접 실행한 Claude turn의 완료가 Lenovo에 도착했고,
`apme prune`은 dry-run으로만 실행했다.

App Store export에서 추출한 Mac 앱은 직접 실행할 수 없었다. 따라서 같은 소스와
버전 6601의 development-signed Release 빌드를 사용해 로컬 인계를 검증했다.
스토어에는 CI가 서명한 원본을 그대로 제출했다. Swift 단독에서도 실제 turn이 앱과
Lenovo 타임라인에 전달됐다. CLI 종료 뒤 Swift가 9121로 잠시 물러났다가 기존
120초 bind-failure 기억의 만료 후 9120을 자동 회수했다. 수동 훅 재설치는 없었다.

반대 방향 인계에서 CLI가 응답하지 않는 구간이 있었다. `sample`은 Node 메인 스레드가
SQLite의 `pread`에 머무름을 보였고, 임시 inspector prepare 래퍼는 30초 평가 tick의
`listUnevaluatedRuns` 4,441ms, `listTurnsNeedingOutcome` 2,123ms를 잡았다.
이는 앞서 수정한 Work board의 tool-count 쿼리와 다른 경로다. DB에는 run 3,351개,
eval 13,329개가 있었고, 두 쿼리는 payload-bearing 테이블 전체를 읽고 임시 정렬했다.

`idx_runs_closed_queue`는 closed-run 선택/분류/정렬/반환 열을 커버하고,
`idx_turns_pending_outcome`은 응답이 있으면서 outcome이 없는 turn만 담는다.
기존 조회 의미는 바꾸지 않았다. 따뜻한 캐시에서 같은 DB의 전후 실측은 각각
4.99→0.35ms, 3.55→0.01ms였고, 이 수치를 앞선 I/O stall 표본과 직접 비교하지 않는다.
회귀 테스트는 실제 store 메서드가 준비하는 SQL의 실행 계획과 필터/순서를 검증한다.
Work board와 abandoned-run 회귀를 포함한 16개 테스트, 전체 4,459개 테스트,
bridge typecheck 및 전체 빌드가 통과했다. npm 태그는 수정 커밋의 재설치와
세 모드 재검증 이후에만 만든다. 최종 결과는 #314에 기록한다.
