# 2026-03-19 — Apple Release (TestFlight) CI/CD 설정

### 문제
Apple 앱(iOS/macOS)을 TestFlight으로 자동 배포하는 파이프라인이 없었음. Android는 GitHub Actions + APK Release가 이미 구축되어있었으나 Apple 쪽은 미구축.

### 해결
1. **Bundle ID 변경**: `dev.agentdeck.dashboard` → `bound.serendipity.agentdeck` 시도 → Personal Team에서 글로벌 선점되어 사용 불가 → `bound.serendipity.agentdeck.dashboard`로 확정
2. **project.yml + project.pbxproj + SettingsScreen.swift**: bundle ID 전체 반영, iOS 테스트 타겟 오타 수정 (`agentdec` → `agentdeck`)
3. **GitHub Actions workflow**: `.github/workflows/apple-release.yml` — `apple-v*` 태그 트리거, iOS/macOS 병렬 빌드, keychain cert import + ASC API key 인증, `xcodebuild archive` → `exportArchive` → `altool --upload-app`
4. **로컬 빌드 스크립트**: `scripts/build-apple-release.sh` — `--ios`/`--macos`/`--all` 옵션, ASC env vars 설정 시 TestFlight 업로드
5. **ExportOptions.plist**: `app-store-connect` method, automatic signing
6. **App Store Connect**: 앱 "AgentDeck Dashboard" 등록, API Key 생성 완료

### 교훈 / 핵심 설계 결정
- **Apple Bundle ID는 글로벌 유니크**: 도메인 소유권 검증 없음. Xcode 자동 signing이 Personal Team으로 빌드하면 해당 Bundle ID를 글로벌 선점 — 유료 팀에서 재등록 불가. Personal Team의 App ID는 developer portal에도 안 보여서 진단이 어려움
- **Plugin UUID ≠ Apple Bundle ID**: Stream Deck 플러그인 UUID(`bound.serendipity.agentdeck`)와 Apple 앱 Bundle ID는 별개 시스템이므로 일치할 필요 없음
- **Distribution Managed 인증서**: Xcode 자동 관리 인증서로 CI에서도 `-allowProvisioningUpdates` + ASC API key 조합으로 프로비저닝 해결 가능

---
