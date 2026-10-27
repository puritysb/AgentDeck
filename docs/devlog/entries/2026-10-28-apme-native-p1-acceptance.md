# 2026-10-28 — APME P1 native acceptance

Catalog exclusion: dated local acceptance evidence, not a product specification.

### Installed state and checks

P1 source `f5e6c02f` and full verification receipt commit `38764183` were
integrated into local master and deployed to the development macOS app and
Node daemon. The App Store app was preserved. The full verification receipt is
`verification/receipts/2026-10-27-f5e6c02.json`; the separate macOS E2E run with
keychain access passed 30 cases.

The native APME window displayed judge provenance, reasoning, completed and
missing items, and archived requests and responses. A synthetic task's user
assessment survived refresh, was cleared afterwards, and did not alter its AI
score. A task without a captured reply displayed insufficient evidence and
0/1 replies rather than a failure score. Fixtures used `agentdeck-fixture`,
excluded from model recommendations.

### Menu-bar automation pitfall

On this Mac, CUA could not target the status item, and System Events AXPress
and coordinate clicks returned successfully without opening MenuBarExtra.
Command success alone did not prove the interaction occurred.

After the user explicitly authorized CGEvent mouse input, a click opened the
native menu panel. Selecting the recent missing-response fixture changed the
APME window from the previously selected graded task to a session-scoped Work
view containing that fixture alone. Its detail showed the expected original
request, insufficient evidence and 0/1 captured replies. This completed the
previously pending recent-task shortcut acceptance on 2026-10-28 at 02:11 KST.

The menu panel remained above the report after navigation; toggling its status
item exposed the full detail. Screenshots and the updated verification JSON
remain local under the chat's `apme-p1-native-deploy` artifact directory.
No credentials or real task transcripts are included in this record.
