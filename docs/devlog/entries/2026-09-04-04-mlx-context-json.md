# 2026-09-04 — MLX 판정이 고정 모델·실제 context 한계·국소 JSON 오류를 견디도록 보강

로컬 MLX 판정 경로에서 서로 다른 세 운영 실패를 확인했다. 분류기는 사용자 설정의
`llm.mlx.model`보다 `/models`의 첫 다운로드 항목을 먼저 사용해, 서버가 이미 올린 모델 대신
오래된 후보를 요청하고 hot-swap할 수 있었다. 긴 `task_rollup`은 서버가 정확히
`16129 prompt + 800 generation > 16384 MAX_KV_SIZE`라고 거절했지만 재시도 없이 판정을
버렸고, Gemma 4가 긴 응답에서 남긴 trailing comma 또는 보조 key의 opening quote 누락은
나머지 점수 JSON이 유효해도 전부 폐기했다. 직렬 로컬 서버가 다른 요청 하나를 처리하는 동안
8초 probe와 60초 본 요청 timeout도 실제 68.7초 응답을 오프라인으로 오판했다.

분류기는 명시적으로 고정한 모델을 우선하고, 고정값이 없을 때만 catalog를 탐색한다. MLX
probe/bounded call 예산은 각각 30초/90초로 늘렸다. 서버가 tokenizer 기준 context overflow를
정확히 반환하면 그 수치로 한 번만 축약해 재시도하되, rubric/초기 목표가 있는 앞부분과 최신
turn/trajectory/instruction이 있는 뒷부분은 보존한다. JSON repair는 문자열 밖의 trailing comma와
object-key 위치의 제한된 bare identifier만 고쳐 evidence 문자열은 byte-for-byte 유지한다.

검증: APME classifier/runner 63 tests, bridge TypeScript typecheck, 전체 Vitest **252 files /
3,871 tests**, docs check 통과.

---
