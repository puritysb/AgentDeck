# 2026-11-02 — Physical-check waiver exposed a separate e-ink routing defect

The owner replaced non-automatable physical release checks with code review for
2.0. This changes release acceptance, not the recorded outcome of a hardware
run. The existing full receipt's un-attested lab entries remain untouched;
future receipts record the waiver as skip, never pass.

Review of the slow e-ink input path found a defect independent of optical
measurement. `snapshot()` copied global focused options onto the first waiting
row, and the reply carried only that row's ID and a positional index. Native
held-question handlers correctly refused the missing question echo. The local
paint hash prevented some stale presses but could not repair the wrong option
source or restore original indices.

The Decision projection now captures the first waiting session's own request.
Only an exact displayed request can compose a reply. Genuine permission IDs
produce Allow/Deny; questions retain their original indices and raw escaped
question. More than three question options remain observation-only on this
three-choice surface. Overflow returns no command, and rejected hardware key
presses do not suppress the replacement question.

Storage is fixed: one bounded Decision per existing static render snapshot,
one retained displayed Decision, and a reused `Net::OUTBOUND_MAX_LEN` command
buffer. No allocation enters the render or input loop. EPD47's large frames
continue to use one-time checked PSRAM allocation and optional-buffer fallback.
Host tests exercise the exact production projection/serializer; panel timing,
ghosting, driver behavior and real button operation remain unmeasured.

See [the acceptance decision](RELEASING.md#20-code-review-acceptance-instead-of-physical-checks-2026-11-02).
