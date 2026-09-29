# 2026-05-08 — macOS App Store profile 호환성: App Group 제거

### 문제
- `apple-v1.0.4` CI에서 iOS archive/export/TestFlight 업로드는 성공했지만, macOS는 archive + `verify-appstore-archive.sh` 통과 후 `xcodebuild -exportArchive`에서 실패.
- 자동 signing export는 ASC API key cloud signing 권한 문제로 `Cloud signing permission error` / `No profiles`를 반환.
- 수동 export로 전환하자 현재 GitHub/local `AgentDeck Dashboard macOS AppStore` profile이 `com.apple.security.application-groups`를 포함하지 않아 entitlement/profile mismatch가 확인됨.

### 해결
- 현재 1.0 App Store 제품에는 helper/extension/login item이 없어 shared container가 필수 기능이 아니므로 `com.apple.security.application-groups` entitlement를 제거.
- App Store macOS 데이터 루트는 `AgentDeckPaths.swift`에서 앱 sandbox container의 `Application Support/AgentDeck`로 고정. Node CLI/unsigned dev/xctest는 기존 `~/.agentdeck/` 유지.
- Claude/Codex hook snippet, setup inlined snippet, Stream Deck plugin, bridge session registry는 discovery 순서를 `~/.agentdeck/daemon.json` → App Store sandbox container `daemon.json` → legacy App Group `daemon.json` → fallback으로 확장. 기존 pre-1.0 candidate와 호환성을 유지한다.
- `ExportOptions-macOS.plist`는 manual signing + `AgentDeck Dashboard macOS AppStore` provisioning profile + `Mac Installer Distribution` automatic selector로 명시해 CI가 cloud signing에 의존하지 않게 함.
- `CLAUDE.md`, App Review notes, feature matrix, certificate setup guide, README/daemon/TestFlight docs의 data-dir/App Group 설명을 현재 shipping contract에 맞게 갱신.
- `apple-v1.0.5` CI 결과: iOS 1.0.5 build 6 archive/export/TestFlight 업로드 성공. macOS archive + verifier 성공, export는 `No certificate ... matching 'Mac Installer Distribution'`로 실패. 현재 `APPLE_CERTIFICATE_BASE64` secret에는 Mac Installer private-key identity가 없으므로 secret 재수출이 필요하다.
- 다음 재시도는 이미 올라간 iOS build 6 중복 업로드를 피하기 위해 Apple version `1.0.6`, build `7`로 진행한다. workflow는 macOS job 초기에 `security find-identity -p basic`으로 `3rd Party Mac Developer Installer` identity를 검사해 누락 시 즉시 명확한 에러를 낸다.

---
