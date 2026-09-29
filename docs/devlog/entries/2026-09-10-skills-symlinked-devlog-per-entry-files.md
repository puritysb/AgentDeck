# 2026-09-10 — 슬래시 스킬은 없었고 로그는 충돌 지점이었다: `.claude/skills` 심볼릭 링크 + 로그 항목별 파일화

**스킬.** `.claude/skills/deploy.md` 같은 평면 포인터 파일 3개는 두 번 죽어 있었다. `.claude/` 전체가 gitignore 라 새 클론엔 없었고,
Claude Code 2.1.x 는 `.claude/skills/<name>/SKILL.md` 디렉토리 형태만 발견하므로 이 머신에서도 `/deploy` 는 스킬 목록에 없었다(이 세션의
스킬 목록에도 `deploy`·`sdc-diagnose`·`esp32-heap-discipline` 이 없었고, 방금 실행된 `session-end` 는 저장소 것이 아니라
`~/.claude/commands/session-end.md` 였다). 포인터를 유지하는 대신 `.claude/skills/<name>` → `../../.agents/skills/<name>` 심볼릭 링크 5개를
git 에 추적하고(`.gitignore` 에 `!.claude/skills/`), `claude -p` 로 스킬 목록을 뽑아 5개 전부 나타나는 것을 확인했다. 사본이 0개가 되었으니
"포인터를 절차 사본으로 바꾸지 말라"는 규칙도 필요가 없어졌다 — 링크는 드리프트할 수 없다.

**로그.** 108개 세션 transcript 실측(같은 날 앞 항목): 쓰기 73 대 읽기 35, 읽기의 상당수가 충돌 마커 확인, 키워드 검색 ≈0. 원인은
모든 세션이 `DEVELOPMENT_LOG.md` 맨 위 같은 줄에 prepend 하는 구조 자체다. 한 항목 = 한 파일(`docs/devlog/entries/YYYY-MM-DD-<slug>.md`)로
바꾸고 `DEVELOPMENT_LOG.md`·`docs/devlog/YYYY-MM.md`·README 를 `scripts/devlog-build.mjs` 가 생성한다 — 생성물은 머지 양변이 아니므로
충돌하면 다시 빌드하면 끝(CLAUDE.md 의 SYNC-HASH 규칙과 같은 원리). `pnpm devlog:check` 가 stale 생성물·형식 어긋난 항목에 CI 를 막고,
아까 만든 `devlog-archive.mjs` 는 이 빌더가 흡수해 삭제했다. 항목 파일은 링크를 저장소 루트 기준으로 쓰고 빌더가 깊이에 맞춰 `../../` 를
붙이므로 `check-docs.mjs` 는 `docs/devlog/entries/` 의 링크 검증만 건너뛴다(생성물 쪽에서 같은 링크를 검증한다).

**마이그레이션.** 활성 로그 + 월별 아카이브 6개에서 750개 항목을 파일로 옮겼다. 제목 뒤 형식이 `2026-08-03 (3) — …`, `2026-04-25 → 27 — …`,
`2026-04-11 - …`, `(심야)` 등 13가지로 갈려 있어 날짜 뒤를 **통째로 원문 보존**한다(새 항목 규약은 `# YYYY-MM-DD — 제목`). 같은 날 여러 항목의
순서는 두 자리 위치 접두어(`2026-09-10-07-…`, 위쪽=큼)로 고정했고, 새 항목은 접두어가 없어 문자 정렬상 같은 날 가장 위에 온다. 검증: 항목 750→750,
제목 유실 0, 본문 차이 0(링크 접두어 제외), 같은 날 안의 순서 전부 보존. 날짜 간 순서는 5곳이 바뀌었다 — 옛 파일이 prepend 시각 순서라 오래된
날짜가 위에 끼어 있던 자리들이고, 생성물은 날짜 내림차순이다.
