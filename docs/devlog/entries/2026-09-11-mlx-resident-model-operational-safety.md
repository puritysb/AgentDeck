# 2026-09-11 — MLX 운영 모델 교체와 GPU 오류 재시도 차단

실시간 classifier 측정 스크립트가 `/v1/models`의 첫 다운로드를 선택해 운영 Gemma를
Qwen으로 교체했다. MLX-VLM 0.6.15는 이전 generation 스레드의 10초 join이 끝나지 않아도
교체 로드를 진행했고, client timeout 뒤 서버 추론도 계속됐다. 반복 교체 중 GPU peak는
18.12 → 33.91 → 35.30 → 50.84 → 78.55GB로 증가했다. 살아 있는 OOM 프로세스에 대해
`/health`는 healthy를 반환했고 launchd KeepAlive도 복구를 하지 않았다.

Node·Swift의 judge/classifier/summary/readiness에 resident-model 검증과 endpoint 단위
동시 실행 제한을 적용했다. 응답 본문 완료까지 admission을 유지하고 timeout/5xx/429
이후 5분간 재시도를 막는다. metrics의 busy/OOM도 확인한다. 모델을 추측하는 fallback과
다른 judge backend 설정의 MLX 유입을 제거했다. 초기 설정 화면도 MLX 상주 모델만 제시하며
MLX backend를 선택한다. 일반 OpenAI 자동 모델 선택은 singleton만 허용한다.

공통 정책은 `shared/src/mlx-safety.ts`, Swift는 생성물과 공통 벡터로 검증한다.
배포 앱은 네트워크 API만 사용한다. 운영자용 `scripts/mlx-server-guard.py`는 검증된
MLX-VLM 0.6.15에만 적용하며, pin 이외의 loader 호출을 409로 차단하고 OOM·GPU 예산
초과 시 supervisor가 복구하도록 프로세스를 종료한다. 이 어댑터는 앱에 포함하지 않는다.
구형 서버의 singleton 호환과 프로세스 간 경쟁, watchdog의 한계는 `docs/apme.md`에 기록했다.

로컬 운영 guard 적용 후 14분간 추론 28건 완료/0건 실패, GPU peak 17.97GB를 확인했다.
Dashboard는 메모리 복구 이후에도 main-thread SwiftUI transaction 처리에 머물러 재실행했다.
재실행 후 UI 응답을 확인했지만, 그 hang의 직접 원인을 MLX로 단정하지 않는다.

검증: Node 전체 4,398 passed/1 skipped, macOS XCTest 52 passed, build/typecheck,
프로토콜 생성 무변경, Swift 정책 drift gate, docs check, 디자인 토큰 동기화 통과.
디자인 lint는 변경하지 않은 HTML 문서와 Ulanzi 빌드 산출물에서 91건을 보고했다.
