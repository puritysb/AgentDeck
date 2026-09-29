# 2026-07-19 — AgentDeck Dashboard 1.0.0 App Store 제출 완료

### 문제

로컬 검증기(`validate-appstore-submission.sh`)가 전부 green인 채로 ASC 실제 업로드가
두 건 리젝됐다 — 프리뷰 영상 "지원되지 않거나 손상된 오디오", iPhone 스크린샷
"잘못된 크기". 그리고 `apple-v1.0.0` 태그의 CI 아카이브가 macOS에서만
Swift 6 동시성 에러 4건으로 실패했는데, 로컬 `xcodebuild`(Xcode 26.6)는 같은
코드를 문제없이 컴파일했다.

### 해결

- **프리뷰 오디오**: `-an`으로 오디오 트랙 자체가 없었다. ASC는 무음 캡처라도
  최소 AAC-LC 트랙을 요구 — `anullsrc` 무음 스테레오 트랙을 muxing하도록 수정하고,
  validator에 오디오 스트림 존재/코덱 검사를 추가.
- **iPhone 스크린샷 크기**: 캡처 디바이스가 "iPhone 16 Pro Max"(1320×2868, 6.9" 버킷)였는데,
  이 앱 레코드의 스크린샷 슬롯은 6.5" 버킷(1242×2688 또는 1284×2778)만 받았다.
  캡처 디바이스를 iPhone 14 Plus(1284×2778 네이티브)로 바꾸고, validator의 허용
  크기 목록을 "이론상 유효한 모든 Apple 사이즈"가 아니라 **ASC가 실제로 뱉은 에러
  텍스트 그대로**로 좁힘.
- **Xcode 26.3 리전 분석**: `DaemonServer`의 보이스 어시스턴트 콜백 3곳이
  `MainActor.run` 리전 안에서 만들어져, 내부 `Task { @DaemonActor in ... }`가 그
  리전의 강한 `self`를 캡처 — 26.3만 "sending self risks causing data races"로 거부.
  콜백을 MainActor 진입 **전**, 데몬 자신의 isolation에서 미리 만들어 캡처 지점을
  분리. `OpenClawAdapter`의 `?? (payload[...]).flatMap { }` 체인도 같은 이유로
  명시적 if-let으로 언롤.
- ASC 심사 메모 재검토 중 카피가 APME 평가(아직 "방향 지표" 단계)와 디스플레이
  프리뷰 개수를 과하게 내세우고 있다는 지적을 받아, Promotional Text 6개
  (ko/ja/en × macOS/iOS)에서 그 두 가지를 헤드라인에서 빼고 "필요한 순간에만
  알려준다"는 실제 핵심 가치로 교체.
- `apple-v1.0.0` 태그를 수정 커밋으로 재지정 → CI 4개 잡 전부 success → ASC
  업로드 → 브라우저로 직접 iOS·macOS 둘 다 "심사 대기 중" 확인.

### 핵심 설계 결정

**로컬 validator는 "Apple 문서상 유효한 모든 값"이 아니라 "이 앱 레코드가 실제로
요구하는 값"만 반영해야 한다.** 6.9"/6.7"/6.5" 버킷이 전부 Apple 스펙상
유효해도, ASC가 특정 앱의 특정 슬롯에 무엇을 요구하는지는 실제 업로드로만
드러난다 — 지금 validator의 두 목록 다 그렇게 좁혀졌다.

**로컬 Xcode와 CI Xcode 버전이 다르면 Swift 6 region 분석 결과가 달라질 수 있다.**
로컬이 통과한다고 CI가 통과한다는 보장이 없다 — release 파이프라인은 CI가 실제
사용하는 툴체인 버전으로 주기적으로 검증해야 한다.

### 검증

로컬 `xcodebuild -scheme AgentDeck_macOS -configuration Release build` SUCCEEDED
(Xcode 26.6) · CI `apple-release.yml` run `29684334854` 4/4 잡 success (Xcode 26.3
아카이브 포함) · ASC 브라우저 확인 iOS/macOS 둘 다 심사 대기 중, 빌드 3501.
