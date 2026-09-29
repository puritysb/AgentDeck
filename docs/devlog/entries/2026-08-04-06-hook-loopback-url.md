# 2026-08-04 — Hook loopback URL의 포트 주입 차단

### 문제
Claude/Codex hook 설치기가 `AGENTDECK_PORT`와 `daemon.json`의 포트 값을 검증하지
않고 `http://127.0.0.1:$PORT/...`에 보간했다. 숫자가 아닌 값, 특히 `@`를 포함한 값은
URL 파서에서 앞부분을 userinfo로 바꾸어 loopback이 아닌 호스트로 hook payload를
전송하게 만들 수 있었다. 동일한 snippet이 hooks, setup, macOS 앱에 중복 생성되어
한 작성기만 고치면 설치 경로에 따라 취약한 설정이 다시 생길 수 있는 상태였다.

### 해결
- POSIX 작성기 5곳과 PowerShell 작성기 3곳 모두 환경 변수와 daemon JSON 포트를
  **정수 1–65535**로 제한하고, 검증 실패 시 탐색을 계속하거나 기본값 9120으로
  강등한다.
- POSIX daemon 파일 경로는 Python source에 삽입하지 않고 argv로 전달해, 홈 경로의
  따옴표가 코드로 해석되는 문제도 함께 제거했다.
- 기존 Claude hook에는 migration 9를 추가해 검증 marker가 없는 설치를 한 번만
  자동 재생성한다. Codex OTel endpoint와 Swift daemon 포트 판독에도 같은 범위를
  적용했다.
- 실제 shell 실행 회귀 테스트로 악성 문자열·범위 밖 포트 차단, 정상 daemon 포트
  선택, 따옴표가 포함된 홈 경로를 확인하고, 모든 공동 작성기의 검증 marker를
  교차 검사한다.
- 검증: TypeScript 2,382개, 문서 88개, 변경 대상 macOS 테스트 7개 통과. macOS
  전체 486개에서는 이 변경과 무관한 기존 세션 정렬 기대값 테스트 1개만 실패하고
  1개가 skip됐다.

---
