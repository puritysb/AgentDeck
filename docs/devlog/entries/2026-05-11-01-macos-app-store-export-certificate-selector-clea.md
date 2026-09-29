# 2026-05-11 — macOS App Store export certificate selector cleanup

### 문제

`scripts/build-apple-release.sh --macos` 에서 archive 와
`apple/scripts/verify-appstore-archive.sh` 는 통과했지만, export 단계가
`No certificate for team 'R22679GY5Z' matching 'Mac Installer Distribution' found`
로 실패했다. 로컬 키체인에는
`3rd Party Mac Developer Installer: SEUNG BEOM CHOI (R22679GY5Z)` identity 가
존재했으므로 인증서 부재가 아니라 Xcode 26.4.1 의 automatic selector 해석 문제였다.

### 해결

- `apple/ExportOptions-macOS.plist` 의 `installerSigningCertificate` 를
  `Mac Installer Distribution` 자동 선택자에서 실제 설치된 installer identity common
  name 으로 고정했다.
- `docs/asc-cert-setup.md` 에도 동일한 값과 문제 원인을 반영했다.

### 검증

- `plutil -lint apple/ExportOptions-macOS.plist` — OK.
- `env -u ASC_API_KEY_ID -u ASC_ISSUER_ID bash scripts/build-apple-release.sh --macos`
  — archive succeeded, App Store archive verifier passed, `dist/export_macos/AgentDeck.pkg`
  export succeeded. TestFlight upload 은 의도적으로 env 를 비워 skip.

---
