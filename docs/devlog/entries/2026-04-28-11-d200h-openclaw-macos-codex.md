# 2026-04-28 — D200H OpenClaw / macOS Codex 세션 아이콘 보정

### 문제

D200H 세션 타일의 OpenClaw 캐릭터가 공식 crayfish SVG 를 CGPath 로 옮긴 뒤 여러 path 를 하나의 even-odd clip 으로 합쳐 gradient fill 했다. OpenClaw 의 집게와 몸통 path 는 서로 겹치기 때문에, 전체 path union 에 even-odd 를 적용하면 겹친 부분이 구멍처럼 상쇄되어 작은 D200H 버튼에서 찌그러진 형상으로 보일 수 있었다. macOS Dashboard 왼쪽 SessionListPanel 의 Codex 아이콘은 13pt Image frame 에 공식 SVG 를 꽉 맞춘 뒤 바깥 padding 만 줘, viewBox 가장자리까지 닿는 Codex path 의 anti-aliasing 픽셀이 좌상단에서 잘려 보일 수 있었다.

### 해결

- D200H `fillSvgPathsGradient` 가 even-odd fill 을 path별로 적용하도록 바꿔 OpenClaw shell/claw overlap 이 상쇄되지 않게 했다.
- D200H renderer revision 을 `creature-session-icons-v24` 로 올려 cached PNG 를 무효화했다.
- `SessionCreatureIcon` 에 내부 inset 옵션을 추가하고, macOS SessionListPanel 은 16pt slot 안에서 Codex 2pt / OpenClaw 1.8pt / 기타 1.5pt 내부 inset 으로 렌더한다. 바깥 padding 대신 SVG 자체를 slot 내부로 줄여 edge clipping 을 방지한다.

### 검증

- `git diff --check` 성공
- `xcodebuild build -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/AgentDeckDerivedDataD200hOpenClawIcon CODE_SIGNING_ALLOWED=NO` 성공
- `xcodebuild build -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_iOS -configuration Debug -destination 'generic/platform=iOS' -derivedDataPath /tmp/AgentDeckDerivedDataD200hOpenClawIconIOS CODE_SIGNING_ALLOWED=NO` 성공

---
