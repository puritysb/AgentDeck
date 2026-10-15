# AgentDeck Development Log

The development log is **one file per entry** under [`docs/devlog/entries/`](docs/devlog/entries/), named `YYYY-MM-DD-<slug>.md`. Those files are the only tracked form of the log. This page does not change when entries are added, so it never conflicts.

## Find something

Search the entries, never a whole month at once:

```bash
rg -l '<keyword>' docs/devlog/entries/ | tail -20     # newest last
rg -n '<keyword>' docs/devlog/entries/2026-10-*        # one month
ls docs/devlog/entries/ | tail -20                     # most recent entries
```

For a reading view, run `pnpm devlog:build`. It writes `docs/devlog/view/recent.md` (the current and previous month) and one file per month. These files are git-ignored and never committed.

## Add an entry

Write an entry only for something a later reader cannot get from the diff or the PR. That means a measurement, an incident, a pitfall, or a decision together with the alternatives you rejected.

1. Create `docs/devlog/entries/YYYY-MM-DD-<slug>.md`.
   - Line 1 is `# YYYY-MM-DD — <title>`, and the date matches the filename.
   - Sections are `###` or deeper.
   - Links are relative to the repository root.
2. Commit it with the change it describes. There is nothing to regenerate.

`pnpm devlog:check` (CI) rejects a malformed entry. `pnpm docs:check` validates entry links from the repository root.
