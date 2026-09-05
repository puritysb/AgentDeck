# 2026-09-06 — Attention UI: 별도 브랜치의 네이티브 읽기 전용 관찰

`codex/ui-attention-prototype`에서 합성 A/B/C 비교 다음 단계로
`AttentionContextPanel`을 구현했다. 메뉴바 톱니바퀴의
`Attention context (experimental)`은 기본 off이며 기존 오른쪽 Activity 영역만
바꾼다. 테라리움·기존 컨트롤·데몬·프로토콜은 그대로다. 선택과 기존 행 순서는
새 대기로 바꾸지 않고, 연결 끊김/선택한 세션 소멸은 마지막 맥락으로 명시한다.
관측되지 않은 활동 요약·훅 출처·요청 만료·완료를 추정하지 않는다.

첫 실사용은 [`experiments/attention-lab/native/`](experiments/attention-lab/native/README.md)의 별도 관찰 앱이다.
제품과 동일한 SwiftUI/모델 소스를 직접 컴파일하고, registry와 health PID를 확인한
기존 loopback 데몬에서 `dashboard-live/v1`의 `sessions.read`만 요청한다.
agent command·원문 저장·자동 알림·사용 계측은 없으며 창을 닫으면 연결이 끝난다.
동시 진행 중인 master의 Apple/데몬 변경을 보호하기 위해 기존 앱을 교체하거나
데몬을 재시작하지 않았다. 실제 세션 목록 수신·수동 선택을 확인했고 순수 모델
19개 검사가 통과했다. 사용성 결론이나 제품 기본값 변경은 아직 하지 않았다.
최종 macOS Release 빌드 및 선언된 entitlement의 로컬 ad-hoc 서명을 사용한
App Store archive guard도 통과했다. 배포 서명·스토어 제출·팝오버 실기기 QA는 아니다.
