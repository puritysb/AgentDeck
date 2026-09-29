# 2026-08-07 — Passive Claude sessions recover from abandoned turns

Passively observed Claude transcripts that remain in `processing` without a
write for more than ten minutes now return to `idle`, matching the existing
end-event-loss safeguard for Codex rollouts. The observer keeps the session
visible, clears only the stale task label, and resumes live processing on the
next transcript write.

---
