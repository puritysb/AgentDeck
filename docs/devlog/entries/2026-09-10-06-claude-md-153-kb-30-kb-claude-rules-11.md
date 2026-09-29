# 2026-09-10 — CLAUDE.md 153 KB 는 지도가 아니라 사건 기록이었다: 핵심 30 KB + `.claude/rules/` 11개로 분할

**측정.** 루트 `CLAUDE.md` 가 152,798 B / 309줄(≈4만 토큰 추정)로, 4월 11 KB → 8/15 61 KB → 9/10 153 KB.
`## Key Conventions` 한 절이 89.6 KB, 2,000자 넘는 불릿 22개, 날짜 36개·"measured" 20회 — 규칙보다
사건 서술이 본문이었고 그 서술은 이미 `DEVELOPMENT_LOG.md` 와 `docs/*.md` 에 있었다(표본 20개 식별자 중
17개가 로그/문서에 존재). 공식 지침과 대조: Claude Code 문서는 CLAUDE.md 를 **200줄 이하**로 권하고
("길면 규칙이 묻힌다"), 그 이상은 `.claude/rules/` 의 `paths:` 조건부 로드를 쓰라고 한다. Codex 쪽은
더 나빴다 — `AGENTS.md` 가 "먼저 `CLAUDE.md` 를 읽으라" 했지만 Codex(`gpt-6-astra`)는 셸 출력을
**약 10,000 토큰(≈40 KB) head+tail** 로만 모델에 넘기므로(`truncation_policy`, 중간에 `…N tokens
truncated…`), 지난 몇 주 Codex 세션은 CLAUDE.md 의 앞 20 KB 와 뒤 20 KB 만 보고 "읽었다"고 믿었다.
그 사이(Key Conventions 대부분)가 정확히 데몬 수명주기·페어링·ESP32 플래시 규칙이다.

**결정.** 본문은 한 글자도 고쳐 쓰지 않고 **줄 단위로 옮겼다**(스크립트가 원문 309줄 중 내용 줄 전부를
바이트 대조 — 의도적으로 요약한 2줄만 제외). 항상 로드되는 `CLAUDE.md` 는 지도(모노레포·빌드·교차
규약·규칙 색인)만 남겨 **30,236 B / 222줄**. 도메인 불변식은 `.claude/rules/<domain>.md` 11개
(apme-eval, openclaw-gateway, observed-sessions, usage-quota, esp32-flash, daemon-lifecycle, swift-daemon,
devices-and-wire, managed-sessions, design-system, apple-release; 합계 ≈146 KB)로 가고, 각 파일 첫머리의
`paths:` glob 이 로드 조건이다. `.gitignore` 는 `.claude/` → `.claude/*` + `!.claude/rules/` 로 바꿔
규칙 파일만 추적한다(`.claude/skills/` 포인터는 여전히 로컬 — 새 클론엔 `/deploy` 가 없다는 뜻이고,
이건 이번에 건드리지 않았다).

**Codex/OpenCode/Antigravity.** 경로 조건부 지침 파일이 없으므로(`.codex/rules` 는 실행 정책 전용)
`AGENTS.md` 가 "작업 경로에 맞는 규칙 파일을 첫 편집 전에 읽으라"고 지시하고, CLAUDE.md 상단 표가
`paths → 파일` 지도다. `AGENTS.md` 는 루트→cwd 체인 합계 **32 KiB** 를 넘으면 소리 없이 버려지므로
7.5 KB 로 유지. `esp32/AGENTS.md` 를 새로 두어 cwd 가 `esp32/` 인 Codex 가 `esp32/CLAUDE.md` 와
`esp32-flash` 규칙에 도달하게 했다(루트에서 시작한 Codex 는 이 파일을 절대 못 본다 — 문서화된 동작).
Astra 는 "모순되거나 불명확한 지침에 멈출 수 있다"고 OpenAI 가 명시하므로, `AGENTS.md` 의 낡은 주장
두 개를 지웠다: "Android E-ink 규칙이 CLAUDE.md 에 있다"(없다 — `docs/android-ui.md`), "활성 로그는
최근 2개월"(6~9월 4개월, 1.34 MB 가 들어 있다 — 아카이브는 이번 범위 밖, 별건).

**검증.** `pnpm docs:check` 129 파일 통과(옮긴 링크 20개를 `../../` 로 재작성), `pnpm design-system:check`
통과(`.claude/rules` 는 `docs/` 커버리지 밖). 토큰 절감은 문자수 산술이라 **추정**이며 실측이 아니다.

**로그 운영 재검토(같은 날, 후속).** 108개 세션 transcript 에서 이 파일을 건드린 명령을 분류하니 쓰기 73회 대
읽기 35회였고, 읽기의 상당수는 충돌 마커(`<<<<<<<`) 확인이었다 — 모든 세션이 같은 파일 맨 위에 prepend 하니
병렬 세션마다 충돌 지점이 된다. 키워드로 로그를 검색한 명령은 표본에서 사실상 0. 즉 이 로그는 **거의 쓰기 전용**이고,
읽히는 부분은 `head` 가 보여주는 맨 위뿐이다. 그래서 형식(항목당 중앙값 2.7 KB, 최대 19 KB 의 서사)은 비용이 아니지만,
"2개월 창" 약속을 손으로 지키는 것은 실패했다(6~9월 4개월, 1.34 MB). `scripts/devlog-archive.mjs` 를 추가해
`pnpm devlog:archive` 가 창 밖의 달을 `docs/devlog/YYYY-MM.md` 로 잘라내고(루트 기준 상대 링크는 `../../` 로 재작성,
기존 월 파일엔 날짜순 병합, 재실행 idempotent) README 표를 재생성하며, `pnpm devlog:check` 가 design-system 워크플로에서
CI 를 막는다. 6·7월 243개 항목을 잘라내 활성 로그는 165개 / 672 KB. 슬라이스 전후 11,660개 비공백 줄 전부 대조.

**남은 것.** 같은 날 후속 항목("슬래시 스킬은 없었고 로그는 충돌 지점이었다")에서 둘 다 닫았다: `.claude/skills/` 는 심볼릭 링크로, 로그는 항목별 파일 + 생성물로.
