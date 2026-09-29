# 2026-09-04 — #281: native dependency success is measured under the daemon's Node, and Node 20 stays unsupported

Windows에서 `better-sqlite3` 설치가 선택 의존성 실패로 종료코드 0을 남긴 뒤 APME 전체가
꺼진 #281을 패키지·서비스 런타임 관점에서 다시 판정했다. upstream 12.10이 제거한 것은
Node 20(ABI 115)/23 prebuild이고, 이슈의 실제 데몬 Node 22(ABI 127) prebuild는 존재했다.
따라서 원인은 "데몬 런타임용 바이너리가 없음"이 아니라 **의존성을 설치한 Node와 Windows
Scheduled Task가 고정한 `process.execPath`가 달랐고, optional dependency 실패 뒤 그 동일성을
검증하는 단계가 없었던 것**이다. Node를 바꾼 뒤 task를 재등록하지 않는 일반 설치도 같은
모양을 만들 수 있다.

Node 20 지원은 복원하지 않는다. 2026-04 EOL이라 보안 패치가 끝났고, prebuild가 없는
Windows 사용자에게 Visual Studio Build Tools/source build까지 제품 지원하는 비용을 만든다.
느슨한 `>=22`도 odd release까지 약속하므로 계약을 **22/24/26**으로 좁혔다. 다섯 package
manifest와 setup/source installer가 같은 목록을 쓰고, workspace는 `engineStrict`로 어긋난
개발 설치를 거부한다. `better-sqlite3`는 검증한 12.11.1에 exact-pin해 새 설치가 semver 범위로
prebuild matrix를 바꾸지 못하게 했다.

신규 `agentdeck diag native [--json]`는 현재 `process.execPath`/Node/ABI/platform을 출력하고
같은 프로세스에서 `better-sqlite3(':memory:')` + 실제 쿼리를 실행한다. setup은 bridge 설치
직후 이를 호출하고, `daemon install`도 Scheduled Task 등록 전 같은 검사를 한다. 실패해도
세션·기기 제어 fallback은 유지하되 큰 경고와 단일 복구 경로
(`npx @agentdeck/setup --yes`)를 남긴다. 초기화 원문은 더 이상 버리지 않고
`/health.apme.error`와 `daemon status`까지 전달한다. CI는 Windows Node 22/24/26 matrix에서
optional install의 종료코드를 믿지 않고 이 smoke test 자체를 gate로 쓴다.

검증: Node 26.5.0/ABI 147에서 `better-sqlite3` 12.11.1 in-memory query 성공,
신규/관련 17 tests, 전체 Vitest **252 files / 3,867 tests**, 전체 TypeScript typecheck,
monorepo build, version/docs/design-system gates 통과. Windows 세 ABI는 PR CI가 실측한다.

---
