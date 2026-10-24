# 2026-10-25 — Local development deployment must preserve the Store installation

### Incident

After PR #603 merged, [local deployment run 40109400104](https://github.com/puritysb/AgentDeck/actions/runs/40109400104)
quit the installed App Store 1.9.2/9401 app and then failed with `EACCES` moving
`/Applications/AgentDeck.app` into the repository's backup directory. The bundle
was owned by `root:wheel` and contained its Store receipt. The workflow had no
installation-source check: every push attempted to replace it with Debug build 5.
The error establishes a denied rename; ownership alone does not identify which
macOS permission check denied it.

The backup rename sat outside both `beforeSwap` and the swap rollback handler.
Consequently the installed bundle was unchanged but its process had exited,
and the staged development bundle remained. The Store app was relaunched and
its signature, receipt and executable hash reverified. The staged bundle matched
the already preserved development ZIP and was removed after comparison.

### Decision and regression coverage

The [deployment script](scripts/deploy-local-main.mjs) now detects the Store
receipt before any staging or app lifecycle operation. A Store installation is
preserved, including a deliberately closed app; the Node daemon and Stream Deck
plugin can still be deployed. Its receipt says `preserved-app-store`, so successful
development deployment does not imply the Store GUI contains the merged source.
An unreadable receipt is unknown and stops app deployment, rather than granting
permission to replace the bundle. The receipt is checked again after staging to
protect a Store installation completed during preparation.

Development replacement still works. Backup-rename failures now clean this run's
stage and relaunch the original; failed swaps restore the backup before cleanup.
If rollback itself fails, recovery copies remain available for inspection.
The [regression suite](scripts/__tests__/local-main-deploy.test.ts) uses real
temporary app directories and injected rename errors, without touching the installed
app or shared daemon.

Granting the runner broader app-management access or changing the Store bundle's
ownership was rejected: either would enable an unwanted replacement. Installing a
second GUI with the same bundle identity was also unnecessary for this workflow.
The canonical [deployment skill](.agents/skills/agentdeck-deploy/SKILL.md)
documents the preservation and recovery behavior.
