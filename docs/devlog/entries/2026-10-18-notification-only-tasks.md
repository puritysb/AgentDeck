# 2026-10-18 — Tasks opened only by background-job notices are not judged

The first `agentdeck apme coverage` run raised a question about Claude's task
rollups: some of them start with no request at all. Measured over 30 days in the
Node store, read-only: 70 of 414 closed Claude tasks consist only of turns opened
by a `<task-notification>` envelope, the message Claude Code queues when a
background job finishes. 64 of the 70 had been judged, at a mean 0.772 against
0.912 for the other tasks. The judge had to guess what was asked.

The cause is segmentation, not the judge. Counting every queued envelope
(`<task-notification>`, `<agent-message>`, `<cross-session-message>`), 93 tasks
are made only of queued messages, and 81 of them directly follow a task that the
15-minute idle gap closed (64 of the 70 notification-only ones). The idle gap
closes the task while the background job that task started is still running,
and the job's completion then opens a new task with no intent.

The fix declines such a task as `notification_only` in `task-gradeability.ts`
and its generated Swift mirror. Only `<task-notification>` is declined.
`<cross-session-message>` is another session asking for something.
`<agent-message>` can carry a teammate's question. A task mixing a typed prompt
with notices stays gradeable. On the next Node daemon start,
`retractUngradeableVerdicts` withdraws the verdicts already written inside its
30-day window (64 on this machine on 2026-10-18; the pass reads up to 2,000
judged tasks and the window held 1,003). 3 of the
70 tasks were already declined for another reason and keep that reason, since
the startup pass re-reads declined tasks only to readmit them. The Swift daemon
has no retraction pass, so on a machine that only runs the app the rule applies
to tasks closed from now on.

Two alternatives were rejected.

- **Holding the idle gap while the session's background work is live.** It
  fixes the cause, but a new prompt the user types during the wait merges into
  the old task. A background job that never ends, such as a dev server, would
  hold the task open indefinitely. Both collectors' state machines would change
  together.
- **Reopening the closed task when the notice arrives.** It re-judges a task
  that already has a verdict, and a closed task would no longer stay closed.

Neither alternative, nor this rule, returns the work done after a notice to the
task that started the job. That work is now in no task's score, which is better
than scoring it against an invented request.

Three parity pitfalls in the Swift mirror, each pinned by vectors in
`shared/task-gradeability-vectors.json`:

- **Leading whitespace only.** The TS predicate is
  `^<(tag)[\s>]` over `prompt.trimStart()`. The Swift file's existing `text()`
  helper trims both ends, which would turn `"<task-notification "` into a bare
  tag name with nothing after it, deciding the other way.
- **ASCII case folding only.** A JavaScript `i` regex without the `u` flag
  matches only ASCII case variants, while Swift's `lowercased()` maps the Kelvin
  sign `K` (U+212A) to `k`. The Swift check compares unicode scalars with an
  ASCII-only lowercase. No real prompt contains a Kelvin sign.
- **JavaScript's whitespace, not Unicode's.** `trimStart()` and `\s` include
  the BOM U+FEFF and leave out NEL U+0085; Swift's `properties.isWhitespace`
  (Unicode White_Space) is the reverse on both. The first Swift mirror used it,
  so either character before the tag or right after it decided the notice the
  other way, and all 26 vectors passed. The generator now emits JavaScript's
  set as read from its own engine; a sweep of every Unicode scalar in both
  positions then decided identically in Node and Swift.
