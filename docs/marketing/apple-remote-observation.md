# Apple remote observation — planned feature introduction

**2026-11-01 — development-only PoC; one user-assisted iPhone/Watch delivery route verified.**
This is reusable preview copy, not an announcement of an available feature. A real response-wait alert, encrypted-summary read and offline-age check passed. The development PoC also passed physical iPhone cache/relaunch and local choice/one-time approval checks, plus user-operated Stream Deck+ keys. Quota and Production remain incomplete.
The [technical design](../apple-remote-observation.md) owns the scope and gates;
the [feature matrix](../appstore-feature-matrix.md) owns availability.

## Short introduction

**Planned: know when your local agents need attention while you are away.**
AgentDeck is preparing a CloudKit proof of concept that sends selected updates
from the running Mac app to your iPhone, with eligible notifications forwarded
to Apple Watch. A small read-only view will combine local work status with the
last trustworthy usage reading. Each observation keeps its original time so an
offline Mac never looks like a live source.

## What the first experiment will test

- A real agent entering response wait, plus a clearly labeled test notification.
- A recent summary from one Mac; quota export follows verified account/source provenance.
- iPhone cellular delivery and Apple Watch notification forwarding.
- Honest historical state after sleep, network loss or a missed update.
- Optional sharing through the user's private iCloud database, with stop/delete
  controls and no prompts, commands, paths or provider credentials uploaded.

The intended audience uses local agents and wants attention context beyond a
standalone usage gauge. Combining several providers is a follow-up hypothesis;
the first PoC does not promise a complete subscription dashboard.

## Requirements and limits to keep beside the introduction

The Mac app must be running and online to publish new observations. Mac and
iPhone use the same Apple Account with iCloud enabled; the Watch is paired to
that iPhone. Apple determines where and when notifications appear. Delivery,
background refresh and stale-banner removal are not guaranteed. The private
database uses the user's iCloud storage; there is no AgentDeck-operated relay
in this design. This does not promise unlimited storage or zero support cost.

A dedicated Watch app, Watch complications, phone widgets, remote approvals,
team sharing and Windows/Linux publishers are outside the first PoC. A passed
notification experiment is not evidence that those features are available.
Do not describe an expected quota reset as confirmed replenishment.

## Korean preview copy

**계획 중: 자리를 비운 동안 로컬 에이전트의 확인 요청을 받아보세요.**

AgentDeck은 실행 중인 Mac 앱에서 선택한 상태를 iCloud 개인 데이터베이스로
보내고, iPhone과 Apple Watch 알림 전달로 확인하는 실험을 준비하고 있습니다.
최근 작업 상태와 원본 관찰 시각을 보여줘 오래된 정보를 현재 상태로 오해하지
않도록 설계합니다. 구독 사용량은 계정과 측정 출처를 검증한 뒤 추가할 후속 범위입니다.

개발 기기에서는 실제 응답 대기 알림, iPhone 요약 조회와 오프라인 과거 상태 표시,
Watch 알림 전달을 확인했습니다. 자동 발행과 로컬 캐시를 구현하고, iPhone 실기기의 캐시 복원·로컬 선택 응답·일회 승인 및 Stream Deck+ 물리 키 경로도 검증했습니다. 현재는 개발 전용 PoC이며 배포된 기능이 아닙니다. 첫 실험은 Mac 한 대와
같은 Apple 계정의 iPhone, 연결된 Watch를 대상으로 합니다. Mac 앱이 꺼져 있으면
새 상태를 관찰할 수 없고, 알림 표시와 지연은 Apple의 시스템 설정과 네트워크에
영향을 받습니다. 워치 전용 앱·위젯·원격 승인은 후속 검토 범위입니다.

## Evidence required before a release announcement

Replace the planned label only after recording the build and delivery state,
Development and Production device results, measured late/missing alerts, account
and delete tests, and privacy/review updates. Illustrations must be labeled as
concepts until real captures exist. Do not publish a fabricated screenshot,
"always live", "instant approval", "all subscriptions" or "guaranteed delivery".
