# 2026-09-20 — Provider rows join the saved display preference once (#351)

A provider id added to the vocabulary after a user saved their
`dashboardProviders` preference was invisible until manually toggled in the
UPSTREAM menu — measured live twice in one day: z.ai shipped with live
`zaiRateLimits` frames and the rail stayed empty because the saved list
predated the id. Stable membership (never-remove, seed-once) is by design; the
gap was that "never offered" and "deliberately hidden" were the same state.

**The fix is one decision both daemons make identically** (a pure resolver in
`bridge/src/dashboard-providers.ts`, near-transliterated into
`DashboardProviders.swift`, pinned by `shared/dashboard-provider-vectors.json`
replayed by BOTH suites — the same settings file must not render differently
depending on which daemon holds the port):

- a `dashboardProvidersSeen` superset tracks every id the user has been
  OFFERED: initialization (the client's automatic discovery snapshot) marks
  the discovered ids; a manual save marks the full vocabulary, because the
  menu offers every id;
- on read, a CONFIRMED provider (the daemon currently seeing it live — usage
  block, auth, gateway, mlx/ollama/antigravity state) that is absent from
  both the saved list and `seen` joins exactly once;
- a deliberate later hide keeps the id in `seen`, so the hide always wins;
- a legacy save (no seen key) could only have been offered the frozen
  pre-mechanism ids, so their absence stays a deliberate choice — `zai` is the
  first join-eligible id, and every later vocabulary addition follows.

The Node daemon's `/dashboard/providers` builds the confirmed set from
BridgeCore state; the Swift handler mirrors it from its own caches.
`generate-dashboard-providers` now feeds the Swift resolver's vocabulary slot
(the old local `allowed` list in the handler is gone).
