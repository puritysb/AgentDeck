# 2026-08-30 — Design token self-test가 생성 대시보드의 실제 primitive를 다시 변조한다

`verify-tokens-sync.py --self-test`의 두 CSS-root 케이스가 예전에 제거된
`--ink-900` 문자열을 계속 치환했다. fixture 변조가 no-op이어서 본 검증기가 정상
종료했고, self-test는 이를 실제 drift를 놓친 것으로 보고 원격 Design System job을
실패시켰다. 두 케이스를 현재 번들 대시보드에 존재하는 `--ink-800` primitive로
옮기고, 앞으로 fixture가 다시 낡아도 원인을 즉시 드러내도록 모든 mutation에
no-op guard를 추가했다.
