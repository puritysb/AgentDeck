# 2026-09-11 — 로컬 모델 설치·상주·서버 상태 표시 분리

Dashboard와 메뉴바가 Ollama 설치 목록을 실행 중인 모델처럼 보이게 했다.
MLX `mlxModels`도 구버전 서버에서는 다운로드/선택 목록일 수 있으므로 상주 증거가 아니다.

기존 필드의 이름·자료형·목록 의미를 유지하고 선택 필드 `mlxResidency`,
`ollamaStatus.residency`, `ollamaStatus.installedModelsKnown`을 추가했다.
Ollama `/api/ps`의 실제 항목으로 CPU-only와 embedding 모델도 상주로 판정한다.
조회 실패는 명시적 unknown이며, VRAM 0을 미상주로 단정하지 않는다.
MLX는 `/health.loaded_model`이 명시된 경우만 상주 확인으로 표시한다.

새 Apple 화면은 서버 가용성·상주·설치 목록을 구분한다. 구버전 모델 메시지와 재연결은
이전의 상주 확인을 해제하며 quota-only 메시지는 이를 유지한다. 허브는 구버전 세션
브리지에서 중계된 모델 정보보다 자신의 로컬 관측을 우선한다.
구버전 화면 문구는 업데이트 전까지 유지되지만 새 선택 필드 때문에 연결이나 디코딩이
깨지지 않는다. 호환성 조합은 `docs/wire-compatibility.md`에 기록했다.

검증: build/typecheck, Node 4,407 passed/1 skipped, macOS XCTest 83 passed,
Android ProtocolTest 36 passed. 출시 Apple Codable 형태의 새 필드 무시와 변경하지 않은
Android 프로덕션 파서의 새 프레임 수용, legacy→new→legacy/unload/disconnect를 검증했다.
프로토콜 재생성 drift 없음, 문서 검사·토큰 동기화 통과. 디자인 lint는 앞 작업과 동일한
기존 91건이며 이번 수정 파일에는 해당 위반이 없다. 공개 릴리스는 수행하지 않았다.
