# 2026-08-10 — 초록불 no-op npm 릴리스와 Apple 인증서 누수를 구조적으로 제거

### 확인한 외부 상태

- App Store Connect 를 브라우저로 직접 확인했다. `1.0.5` 는 macOS **4701**
  (09:35 KST), iOS **4702** (09:37 KST) 모두 **심사 대기 중**이다. 제출된 빌드는
  건드리지 않는다.
- Apple Developer 계정에는 같은 날 발급된 Development 인증서가 5개 있었고, 그중
  4개가 `Created via API` 였다. ephemeral runner의 automatic signing이 실패 때마다
  새 개발 인증서를 만들고 private key를 버린다는 가설을 계정 inventory로 확인했다.
- npm 네 패키지는 수동으로 올린 `1.0.17`이 실제 registry 최신이다.
- `t_display_pro`의 `.51`은 케이블 교체 후 장시간 안정적이지만 `.74`는 밤새
  `reset=poweron`을 반복했다. 펌웨어 결함이 아니라 동일한 전원/케이블 처방이 필요한
  물리 문제다.

### 변경

- npm 릴리스는 opt-in 변수와 장기 `NPM_TOKEN`을 버리고 GitHub Actions OIDC Trusted
  Publishing을 쓴다. `npm-v*` 태그는 publish를 건너뛸 수 없고, 네 패키지를 registry에서
  다시 읽은 뒤에만 GitHub Release를 만든다. 부분 publish 뒤 재실행할 수 있도록 이미
  존재하는 immutable version은 건너뛴다.
- Apple 릴리스는 archive/export의 automatic signing과
  `-allowProvisioningUpdates`를 제거했다. 조직 `QF36NDHYHD`의 영속 Apple Distribution,
  Mac Installer Distribution identity와 플랫폼별 App Store profile을 명시적으로
  import·검증한다. ASC API key는 최종 upload에만 쓴다.
- Apple workflow에 `upload=false` 수동 dry-run을 추가했다. 제출 중인 `1.0.5`를
  교체하지 않고 archive/export/invariant 검증을 끝까지 시험할 수 있고, GitHub Release는
  태그 실행에서만 생성된다.
- profile 검증은 iOS의 `application-identifier`와 macOS의
  `com.apple.application-identifier`가 다름을 실제 기존 profile 해독으로 확인해 각각
  검사한다. 둘 다 현재 팀과 `bound.serendipity.agent.deck`가 아니면 Xcode 전에 실패한다.

### 검증

- `pnpm verify-version`, `pnpm build`, 178 files / 2,908 tests, `pnpm docs:check`,
  targeted Prettier, `actionlint`, plist lint, `bash -n`, `git diff --check` 통과.
- `node scripts/publish-npm.mjs`를 `1.0.17` 상태에서 재실행해 네 패키지를 모두 안전하게
  skip한 뒤 registry 재검증까지 통과했다.
- npm package settings의 WebAuthn 저장은 `Something went wrong`으로 반복 실패했다.
  전역 npm 자격증명은 건드리지 않고 임시 `npm login --auth-type=web` 세션을 만든 뒤,
  공식 `npm trust github` CLI의 5분 2FA 승인 창에서 `shared`·`hooks`·`bridge`·`setup`
  모두를 `puritysb/AgentDeck` / `npm-release.yml` / publish 권한으로 등록했다. 마지막에는
  `npm trust list`로 네 package의 서로 다른 trust id와 동일한 repository/workflow를
  registry에서 다시 읽었다.
- Apple Developer portal에서 조직 Distribution(`Q4C8ZR6WR8`)과 Mac Installer
  Distribution(`87A2XACK78`) 인증서, 현재 bundle ID용 iOS/macOS profile을 발급해
  GitHub secrets를 교체했다. no-upload CI dry-run `31349849501` attempt 2는 두 플랫폼의
  archive/export/invariant 검증을 모두 통과했고 upload 단계는 skip됐다. 직후 inventory
  `31350157488`에서 Development 인증서는 전과 같은 5개였다 — manual signing이 새
  Development 인증서를 만들지 않았음을 외부 상태로 확인했다.
- 첫 dry-run은 Homebrew OpenSSL의 최신 PKCS#12 암호화 형식을 macOS `security import`가
  읽지 못해 실패했다. 같은 key/certificate를 legacy-compatible PKCS#12로 다시 export하고
  로컬 `security import`로 두 identity를 실측한 뒤 secrets를 교체해 해결했다.
- 전체 `pnpm lint`는 이번 변경과 무관한 `.venv` 및 vendored Ulanzi SDK JavaScript
  1,536건을 기존 ignore 설정이 포함하지 않아 실패한다.

---
