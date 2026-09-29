# 2026-08-15 — Android 1.0.9 GitHub Release · Google Play 제출

- Android 첫 연결 화면(태블릿/전화/e-ink/설정 공통)에 **컴퓨터에서 AgentDeck을
  먼저 실행해야 한다**는 전제와 두 설치 경로를 직접 표시했다: Mac의 AgentDeck
  Dashboard, 또는 macOS/Windows/Linux의 `npx @agentdeck/setup`. Play 짧은 설명도
  같은 전제를 첫 문장으로 올리고, 전체 설명의 시작 부분에 컴퓨터 companion 요건을
  배치했다.
- Android를 **1.0.9 / versionCode 11**로 올렸다. 전체 JUnit, 버전 동기화, 문서 게이트,
  서명 APK/AAB 빌드와 APK 매니페스트(`dev.agentdeck`, minSdk 29, targetSdk 36)를
  검증했다. PR #191을 병합하고 `android-v1.0.9` 태그를 발행했으며 GitHub Release의
  서명 APK(`agentdeck-v1.0.9.apk`, SHA-256
  `376ea4ad613c62e511946b5d4a08365450ed0b83a1623f4cf05bd8ba2aa31143`)가 공개됐다.
- Play Console 프로덕션에 AAB 11(1.0.9)을 **177개 대상 국가, 100% 전체 출시**로
  업로드하고 영어/한국어/일본어 출시 노트를 넣었다. 기본 영문 스토어 등록정보의 짧은
  설명과 전체 설명 변경을 같은 제출에 묶어 검토를 요청했다. 제출 직후 상태는
  `출시 버전 11 (1.0.9) 검토 중`이다. Google의 사전 자동 검사는 문제 없이 통과해
  실제 심사 큐에 들어갔으며, 기존 공개 버전은 검토가 끝날 때까지
  1.0.6(versionCode 8)이다.

---
