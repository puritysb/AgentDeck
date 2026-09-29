# 2026-08-12 — npm 1.0.18 게시와 Apple 1.0.6 TestFlight 업로드 검증

### 배포 결과

- `npm-v1.0.18`은 GitHub Actions OIDC Trusted Publishing으로 `shared`, `hooks`,
  `bridge`, `setup` 네 패키지를 provenance와 함께 게시했다. registry의 정확 버전과
  `latest`, setup README, GitHub Release까지 확인해 #173의 npm 항목을 완료했다.
- `apple-v1.0.6`은 조직 `Apple Distribution: Serendipity Bound (QF36NDHYHD)`와
  platform별 App Store profile을 manual signing으로 사용했다. macOS installer도 조직
  `3rd Party Mac Developer Installer` identity를 사용했다. 두 플랫폼의 archive/export,
  App Store invariant, altool upload가 모두 성공했다.
- 업로드 직후 ASC certificate inventory는 2026-08-10 baseline과 ID·serial까지 동일했다:
  DEVELOPMENT 5, DISTRIBUTION 1(`Q4C8ZR6WR8`), MAC_INSTALLER_DISTRIBUTION
  1(`87A2XACK78`). 새 Development 인증서가 생기지 않아 #173을 완료로 닫았다.
- App Store Connect TestFlight에서 iOS와 macOS 모두 **1.0.6 (4901), 제출 준비 완료**로
  직접 확인했다. 심사 제출과 공개는 별도 외부 상태이며 아직 수행하거나 완료로 표기하지
  않았다.

### npm read-after-write 대응

- 첫 npm workflow는 네 immutable publish가 모두 성공한 뒤, 마지막 setup을 게시한 지 약
  1.5초 만에 read endpoint를 조회해 전파 지연을 실패로 오인했다. retry-safe 재실행은 네
  패키지를 모두 건너뛰고 registry 검증과 GitHub Release 생성을 완료했다.
- `scripts/publish-npm.mjs`의 최종 검증에 5초 간격 최대 12회의 bounded retry를 추가하고,
  뒤늦은 노출과 영구 미노출을 각각 고정하는 회귀 테스트를 추가했다(PR #179).

---
