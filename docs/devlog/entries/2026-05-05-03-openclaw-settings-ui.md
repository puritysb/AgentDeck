# 2026-05-05 — OpenClaw Settings 정상 상태 UI 정리

### 문제

OpenClaw Gateway 연결이 정상화된 뒤에도 Settings → Integrations 의 OpenClaw row 가
`Connected / Paired through Gateway` 아래에 token import, reconnect, Web UI, reset identity 버튼과
4개 bullet 설명을 항상 노출했다. 정상 상태에서는 "연결됨" 확인만 필요하고, 이 수리 도구들은 오히려
불필요한 조작처럼 보였다. Accounts 섹션의 "No tokens to paste here" 문구도 OpenClaw Advanced token
field 와 충돌했다.

### 해결

- OpenClaw troubleshoot row 는 Gateway 가 available 이면서 connected 가 아니거나 auth error 상태일
  때만 inline 으로 표시한다.
- 정상 connected 상태에서는 `Advanced` disclosure 만 남기고, token refresh / reconnect / Web UI /
  reset identity / token paste field 는 그 안으로 이동했다.
- 기존 4개 bullet 설명을 상태별 1줄 hint 로 축소하고, 버튼 라벨도 `Import token`, `Open Web UI`,
  `Reset identity` 로 줄였다.
- Accounts 섹션 설명을 "repair tools stay in Advanced" 로 바꿔 optional token repair 경로와 충돌하지
  않게 했다.

### 검증

- 정상 연결 상태 UI: OpenClaw row 는 `Connected / Paired through Gateway` + 접힌 `Advanced` 만 표시.
- `Advanced` 확장 시 repair controls 와 token field 가 노출됨.
- `git diff --check` 성공.
- `xcodebuild build -quiet -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -configuration Debug -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/AgentDeckDerivedDataOpenClawSettingsTrim CODE_SIGNING_ALLOWED=NO` 성공.

---
