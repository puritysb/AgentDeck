# 2026-03-17 — macOS App Sandbox + mDNS TXT 부재로 daemon 연결 실패

### 문제
macOS 앱이 Android 태블릿과 동일 daemon에 연결되어야 하나, 3가지 데이터 차이 발생 (agent 목록, timeline, 모델). 근본 원인 2가지:
1. **App Sandbox**: `~/.agentdeck/sessions.json` 읽기 불가 — `FileManager.homeDirectory`가 컨테이너 경로 (`~/Library/Containers/bound.serendipity.agentdeck/Data/`) 반환
2. **mDNS TXT 레코드 비어있음**: NWBrowser가 `metadata=<none>` 반환 → `agentType`이 전부 nil → daemon preference 작동 불가 → 랜덤 session bridge에 연결 → 불완전한 데이터

### 해결
1. `LocalSessionDiscovery` 사용 중단 (sandbox에서 작동 불가, App Store 배포 필수)
2. macOS도 mDNS 기반으로 전환 (Android과 동일 패턴)
3. `BridgeDiscovery.fetchHealthInfo()` — `/health` 응답의 `mode: "daemon"` 필드로 agentType 취득 (TXT 레코드 부재 대응)
4. `autoConnectPolling` — agentType 미해결 bridge 있으면 최대 4초 grace period 후 fallback

### 교훈
- **App Sandbox**: `NSHomeDirectory()`, `FileManager.homeDirectory` 모두 컨테이너 경로 반환. `getpwuid(getuid())` 로 실제 홈 경로 취득 가능하나, sandbox가 파일 접근 자체를 차단하므로 무의미
- **mDNS TXT 레코드**: Apple NWBrowser는 TXT 레코드를 비동기/지연 전달할 수 있음. TXT에만 의존하지 말고 HTTP fallback 필수
- **daemon 우선 연결은 모든 클라이언트의 기본 전제**: daemon 없이 session bridge에 직접 연결하면 sessions_list, timeline, gateway 정보가 불완전. 이 전제가 깨지면 모든 UI가 틀어짐

---
