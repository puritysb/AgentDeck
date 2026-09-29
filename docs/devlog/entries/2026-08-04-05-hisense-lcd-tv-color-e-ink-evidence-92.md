# 2026-08-04 — Hisense LCD TV 오판과 color E-ink evidence 수정 (#92)

### 문제
혼합 패널 제조사인 Hisense의 E-ink 모델을 `model.contains("a7")` 같은 짧은
substring으로 판정해, `75A7N`·`43A7N` LCD Google TV도 E-ink로 분류했다. 또한
`ro.eink.color`/`ro.epd.color` 같은 양성 신호는 색상 승격에만 쓰이고 E-ink evidence
자체를 만들지 않아, 다른 신호가 없는 실제 color reader를 LCD로 조기 반환했다.

### 해결
- Hisense A5/A5C, A7/A7CC, A9, HiReader 계열은 양쪽 영숫자 경계와 검증된 접미사로
  매칭한다. TV의 화면 크기+모델 문자열 중간에 들어간 `A7N`은 더 이상 맞지 않는다.
- 양성 color E-ink 신호를 `SystemProperty` evidence로 승격해 단독 신호만으로도
  `EinkColor`까지 도달시킨다. 기존 truthiness 필터는 `0`·`false`·`off` 등
  false-like property를 계속 거부한다.
- Hisense LCD TV 2종, 실제 E-ink family 변형 9종, color-only evidence, false-like
  color property를 회귀 테스트로 고정했다.
- 검증: Android 단위 테스트 305개, Debug APK 조립, 문서 88개 검사를 통과했다.

---
