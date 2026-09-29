# 2026-03-21 — Terminal Post-it 경량화: Badge 제거, Tab Title 유지

### 문제
Claude Code가 세션 이름을 prompt bar에 네이티브로 표시하고 `--resume`으로 세션 목록도 제공하게 되면서 terminal-postit 기능과 가치가 일부 중복됨. 5줄 LLM 요약 오버레이로 강화하는 방안도 검토 필요.

### 해결
분석 결과 Claude 네이티브는 **정적 세션 이름**, 우리는 **동적 실시간 상태** — 근본적으로 다른 정보. iTerm2 badge(Layer 2)는 워터마크라 rich 정보 표시에 부적합 (폰트 크기 제어 불가, Dynamic Profile 해킹 fragile). Tab title(Layer 1)은 모든 터미널에서 작동하며 탭 바에서 `● AgentDeck | Edit app.ts` 형태로 유일하게 cross-tab 상태 인식 제공.

- `terminal-postit.ts`(435줄) → `terminal-status.ts`(109줄)로 교체
- Layer 2(badge), Dynamic Profile, Story accumulator, LLM 세션 요약 제거
- `timeline-summarizer.ts`에서 `summarizeSessionContext()` + `callLLM()` 제거
- Layer 1(tab title) + Layer 3(user vars) 유지

### 핵심 설계 결정
- **Tab title(OSC 1)이 핵심 가치**: 터미널 여러 개 띄울 때 탭 바만으로 각 세션 상태 파악 가능. Claude 네이티브 세션 이름과 보완 관계
- **Badge는 잘못된 매체**: 워터마크 오버레이는 1-2단어 ambient label용이지 5줄 정보 패널용이 아님
- **LLM 호출 제거**: 실시간 tool name(`Edit app.ts`)이 LLM 한국어 요약(`포스트잇 기능 구현 중`)보다 즉시적이고 정확

---
