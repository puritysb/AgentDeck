# 2026-09-13 — Inline dashboard subscription details

macOS and Android dashboards now show ChatGPT/Google plan metadata once in the owning upstream row. Append the matching subscription date without changing quota gauges or credit balances; remove the duplicate SUBSCRIPTIONS footer. Provider display preferences also govern subscription visibility. Keep the complete reported list and readable dates in Dashboard settings, with a distinction between subscription dates and usage reset timers. Preserve the existing macOS visibility preference as Subscription dates.

Past or invalid dates in the compact row say that the date is unconfirmed, rather than claiming the subscription was cancelled or needs renewal. Dates may be cached or estimated by the producer.

Validation: 4,482 TypeScript tests passed (one skipped), 13 Apple topology helper tests and 15 Android subscription tests passed. Both native apps built; protocol generation and token mirrors are clean, with design lint at the existing 89 findings. Installed macOS and Lenovo dashboards show each plan once and preserve Codex usage, with the subscription date fitting on the subtitle line. The complete subscription list is available in settings. Daemon and firmware behavior is unchanged.
