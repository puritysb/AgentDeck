# 2026-09-12 — 1.3.0 전 스토어 심사 제출

준비 작업을 검토·보완한 PR #313과 npm 실사용 인계에서 발견한 background queue
지연을 고친 PR #315를 머지했다. 전달 증빙은
[#314](https://github.com/puritysb/AgentDeck/issues/314)에 모았다.
스토어·펌웨어 기준은 `04233b7223ede3c8f40ba2bcde9a0500828ea4e5`,
추가 npm 수정의 최종 기준은 `08c917fd9511b2ad74b0699a32eb4c86f203c8e9`다.
전체 테스트 4,459개가 통과했고 1개는 기존 skip이다. 두 PR의 필수 CI도 통과했다.

## 제출 상태

- Apple iOS/macOS 1.3.0(6601): 두 플랫폼 모두 `WAITING_FOR_REVIEW`, 승인 후 공개.
  3개 언어의 미디어 48개는 처리 완료와 원본 MD5 일치를 확인했다.
- Play 1.3.0(16): production 변경사항 심사 중. 자동 사전 검사는 완료됐으며,
  기존 국가 범위와 100% rollout을 유지했다. GitHub APK는 별도로 공개됐다.
- Elgato 1.3.0.0: 공식 CI 산출물로 `Pending review`. 자동 공개는 껐다.
  처리된 DRM preview가 아직 없으므로 encoder 검증은 공개 전 남은 게이트다.
- Ulanzi 1.3.0: 공개 작품에서 새 review version을 만들고 심사 제출까지 완료했다.
  제출 후 다시 열어 7개 언어의 summary/description 전체, OS 및 장치 선택,
  Dial 비선택을 확인했다. CDN ZIP과 로컬 ZIP의 SHA-256은
  `eff83eaf05c101ea060567aa3b91096f71ac8d64183543c16ab5cfd4fcae55fc`로 같다.
  그 뒤 Ulanzi 태그와 GitHub 릴리스를 만들었다.
- ESP32 1.2.3: 12개 보드의 62개 산출물이 공개됐다. TRMNL 식별자는
  `trmnl_75`, `inkdeck`은 호환 별칭이다. merged 이미지 1,590,560바이트와
  SHA-256 `ff8cce4d2597a8da9d32704fa3310482b3ab420fb75c87f494df21d544066661`을 확인했다.

Ulanzi 접근 실패는 브라우저 제어 연결 문제였다. 연결 복구 후 같은 로그인 계정의
공개 작품 목록에서 AgentDeck을 찾았다. author 표시 주소가 로그인 주소와 다르다는
사실만으로 계정 권한 불일치를 결론 내리면 안 된다. ZIP 업로드는 이번에도 7개
언어 카피와 Dial 선택을 초기화했으므로, ZIP 먼저 업로드하고 모든 필드를 복원한 뒤
제출 기록을 다시 여는 순서를 지켰다.

## 최종 설치 검증

PR #315 머지 커밋을 다시 빌드·pack하고 npm 4개 tarball을 실제 PATH에 설치했다.
빌드와 설치본 `dist/apme/store.js`의 SHA-256은
`21e98b922ab4d7c7c6f8412337a5593b4ebcebf1299016410f23959af2af6597`로 같다.
Node 26.5 / ABI 147에서 native SQLite가 로드되고 버전은 1.3.0이다.
Apple은 스토어와 같은 소스·6601의 development-signed Release로 검증했다.

CLI 단독의 실제 Claude `pwd` turn 완료를 Lenovo 타임라인에서 확인했다.
CLI 단독 상태 확인 30회는 실패 0, 최대 1,566ms이고 앱 동시 실행 30회는 실패 0,
최대 951ms였다. CLI 종료 후 Swift PID 52866이 기존 bind retry 주기를 거쳐
17:02:29 KST까지 9120을 자동 회수했다. Swift 단독 30회는 실패 0, 최대 108ms다.
Swift에서 실행한 별도 Claude turn의 완료도 Mac과 Lenovo 양쪽에 전달됐다.
수동 훅 재설치는 없었다.

반대 방향에서는 CLI가 Swift에 stand-down을 요청하고 약 5초 뒤 포트를 넘겨받았다.
최종 Node PID 72983, build `e952eaa1c4c2`가 9120의 단독 소유자로 시작했고,
Mac 앱은 실제 세션 목록을 다시 받았다. 세션·장치 식별정보를 포함하는 원본
진단 파일은 공개 저장소에 추가하지 않았다.

전환 뒤 30회 상태 확인도 실패 0, 최대 1,006ms로 통과했다. Pages는 기존 빌드가
펌웨어 공개보다 앞서 1.2.2를 가리켰으므로 run 34681541685를 재실행했다.
웹 설치기의 index는 1.2.3으로 바뀌었고 manifest 및 내려받은 TRMNL 이미지가
GitHub 릴리스와 일치했다. 이 게이트를 확인한 뒤 최종 npm 커밋에만 태그했다.

검증용 Mac 앱은 보관하고 원래 설치 앱을 복원했으며 npm 1.3.0 데몬은 유지했다.
이전 기록의 로컬 앱 빌드 6301 표기는 스토어 기준과 혼동한 값이었다. 복원 전
두 백업의 Info.plist를 다시 읽은 실제 로컬 기준은 **1.2.1, CFBundleVersion 2**이며
MAS receipt가 없었다. 백업 디렉터리 이름의 6301은 실제 빌드 증거가 아니다.
이번에 띄운 시뮬레이터를 종료했고 임시 9220/9229 리스너도 남지 않았다.


npm run 34682450639는 성공했고 공개 GitHub 릴리스도 생성됐다. 레지스트리에서
`shared`, `hooks`, `bridge`, `setup` 네 패키지의 exact version과 latest를 각각 읽어
전부 1.3.0임을 확인했다. 공개 시각은 08:08:53–08:10:04 UTC이며,
조회 직후 shared가 잠시 보이지 않던 구간도 최종 공개 확인 후 통과 처리했다.
스토어 심사 제출과 실제 공개는 README의 별도 상태로 유지한다.
