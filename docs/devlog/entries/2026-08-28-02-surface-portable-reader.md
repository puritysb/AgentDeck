# 2026-08-28 — Surface portable-reader에 라이선스 학습팩 배포를 넣는다

Pocket Daily의 SD 오프라인 학습팩이 기기 쪽에서만 구현되어 AgentDeck은 Feed 광고와
바이너리 배포를 하지 못했다. Surface v1의 호환 추가로 `learning.pack.read` /
`learning.pack.update` capability와 `learningPack` advert, 인증된
`GET /learning/pack?id=&version=` 경로를 Node·Swift 데몬에 함께 추가했다.

두 데몬은 광고 전에 SPDX 허용 목록, attribution/source ledger, 전송 MD5, PDLP header
checksum과 payload SHA-256을 모두 검증한다. Node npm 패키지와 App Store 서명 번들에
동일한 CC BY-SA 4.0 누적 N5–N3 학습팩(612자)을 포함하고 테스트가 두 복사본의 byte
identity를 고정한다. OTA가 staged된 Feed에서는 학습팩 광고를 생략해 firmware-first bootstrap을
보존한다. 공개 schema/fixture와 Pocket Daily community manifest도 같은 capability를
선언한다.

검증: bridge/shared typecheck, Surface schema/runtime 및 learning-pack Vitest,
`AgentDeckTests_macOS` 컴파일, 코드 서명 없는 macOS 앱 빌드 통과.

---
