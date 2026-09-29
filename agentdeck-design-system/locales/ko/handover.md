---
id: system.handover
title: 에이전트 인계 계약
description: 에이전트가 소유권을 찾고 스펙을 변경하며 검증 근거와 인계 내용을 남기는 방법.
category: Engineering
locale: ko
canonical: false
status: reader-translation
owner: Repository maintainers
reviewed: 2026-07-18
revision: 2026-07-18-ko
translation_of: system.handover
source_revision: 2026-07-18
source_of_truth: agentdeck-design-system/docs/handover.md
validators: [node scripts/build-design-system-viewer.mjs --check]
---

# 에이전트 인계 계약

시각 규칙, 기기 스펙, 제품 정책, 검증을 바꿀 때 이 계약을 따른다. 영어 문서가 정본이며 이 문서는 독자를 위한 번역이다.

## 소유권부터 확인

| 변경                     | 먼저 수정할 정본                      | 이어서 갱신할 항목                            |
| ------------------------ | ------------------------------------- | --------------------------------------------- |
| 색상·타입·간격·반경·모션 | `design/tokens.css` 또는 `DESIGN.md`  | 토큰 미러, 컴포넌트 규칙, 뷰어 예시           |
| 재사용 컴포넌트          | `design/components.css` + `DESIGN.md` | 런타임 구현과 시각 specimen                   |
| 패널·칩·전송·지원 상태   | `docs/hardware-compatibility.md`      | 도메인 운영 문서와 Devices 요약               |
| App Store 기능·문구 경계 | `docs/appstore-feature-matrix.md`     | Review notes, 메타데이터, 아카이브 검증기     |
| 테스트 주장              | `docs/testing.md`                     | 테스트 구현, 시나리오 매핑, Build Health 설명 |

## 변경 순서

1. `AGENTS.md`와 소유 문서를 읽는다.
2. 미러나 화면보다 정본 스펙을 먼저 수정한다.
3. 스펙을 만족하는 최소 런타임 변경을 구현한다.
4. 명시된 검증기와 실제 동작을 실패시킬 수 있는 런타임 검증을 실행한다.
5. 영어 revision이 확정된 뒤 번역을 갱신한다.
6. 소유권 변경과 검증 근거를 `DEVELOPMENT_LOG.md`에 남긴다.

빌드 래퍼는 실기 근거가 아니고, 스크린샷은 프로토콜 근거가 아니다. 인계에는 정본, 미러·번역, 영향 표면, 검증 결과, 남은 실기 확인을 명시한다.
