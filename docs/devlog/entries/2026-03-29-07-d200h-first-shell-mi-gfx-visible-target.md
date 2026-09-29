# 2026-03-29 — D200H 현재 점검: first-shell 로그로 MI_GFX 성공 확인, visible target 재의심

### 상황
- 재부팅 직후 첫 `adb shell`에서만 유의미한 정보가 나오는 경우가 많고, 그 이후 `adbd`가 쉽게 hang함
- 한동안 실험이 계속 오염됐는데, 원인 중 하나는 호스트에서 별도로 돌던 전역 프로세스:
  - `node /Users/puritysb/Library/pnpm/agentdeck opencode`
- 이 프로세스가 정적 `/data/agentdeck`용 `adb push`와 `adb shell`을 계속 되살려 로컬 repo 기준 테스트와 충돌했음

### 조치
- 전역 `agentdeck opencode` 프로세스를 강제로 종료
- D200H 실행 경로를 `/data/agentdeck-dyn`로 분리한 상태를 유지
- on-device agent stdout/stderr를 무버퍼로 변경
- device shell에 `sleep`이 없어 single-shot takeover 스크립트에서 `sleep 1` 제거
- first-shell takeover를 직접 실행해 startup 로그를 확보

### first-shell startup 로그 핵심
- `AgentDeck D200H Agent v1.0`
- `fb0 smem_start=0x30121000 line_length=2160`
- `MI_GFX backend initialized (bus_base=0x50121000)`
- `MI_GFX: active`
- `Framebuffer OK (960x540)`

### 현재 판단
- 동적 agent는 실제로 실행되고, `MI_GFX` 초기화도 성공함
- 그런데 이 부트에서 agent가 선택한 타깃 `0x50121000`은 여전히 검은 화면이었음
- 반면 저장소 기록과 과거 실기기 성공 경로는 `0x50101000`
- 따라서 지금의 가장 강한 가설은:
  - takeover 자체는 됨
  - 문제는 `MI_GFX` 존재 여부가 아니라 **visible target 주소 드리프트**

### 후속 조치
- `zkswe/agent/src/framebuffer.c`와 `zkswe/agent/src/fb_test.c`를 다시 수정해
  D200H에서는 `0x50101000`을 우선 사용하도록 변경
- 새 `agentdeck-d200h-dyn`를 재빌드
- 그러나 직후 실검은 ADB window collapse와 stock firmware 복귀 때문에
  끝까지 안정적으로 검증하지 못함

---
