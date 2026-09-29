# 2026-08-05 — XTeink X3/X4를 오프라인 우선 Pocket Reader 제품으로 전환

### 방향
XTeink 앱을 AgentDeck 세션 대시보드의 주변 화면이 아니라, 네트워크 없이도
전자책과 저장된 개인 카드를 소비할 수 있는 독립적인 Pocket Reader로 재정의했다.
일반 부팅은 Pocket으로 진입하고, Back을 누른 부팅은 로컬 Library, Confirm을
누른 부팅은 마지막 책으로 바로 들어간다. Wi-Fi 미설정·연결 실패도 오류 화면이나
강제 설정 흐름이 아니라 저장 콘텐츠를 계속 읽는 정상적인 Offline 상태다.

### 구현 계약
- XTeink Overview는 `Continue Reading`과 저장된 Pocket 카드만 보여준다. live
  session, permission, quota, work-wrap-up 행과 AgentDeck 브랜드 셸은 제거했다.
- `GET /feed?surface=pocket-reader`를 추가해 daemon이 live session projection과
  THREAD를 제외하고 자율 Pocket 모듈만 제공한다. 기존 feed 호출은 호환된다.
- Later/Done은 SD outbox에 먼저 기록된 뒤 로컬 카드가 제거된다. daemon은
  `choiceId: later`를 중립적인 읽기 상태로 저장해 같은 카드가 다음 동기화에서
  즉시 돌아오지 않으며 학습 선호도에는 반영하지 않는다.
- 보통 부팅과 배터리 idle cadence에서 Pocket background sync를 기본 활성화했다.
  네트워크는 짧게 동기화한 뒤 다시 꺼지고, 전자책·캐시·outbox가 제품의 정본이다.
