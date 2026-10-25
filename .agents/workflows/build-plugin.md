---
description: Build, deploy and verify Stream Deck plugin
---
# Stream Deck development deployment

For macOS development, use the persistent main checkout. Integrate current upstream changes without
resetting local development work, then install dependencies with `pnpm install`.

Run `pnpm plugin:deploy`. This builds shared/plugin, preserves any packaged
installation, restores the source link, restarts the plugin and verifies the
running process against the bundle SHA-256. A failed link or missing runtime
receipt is a failed deployment, even if compilation succeeded.

Run `pnpm plugin:check` for read-only verification. After testing a Marketplace
package, run the deployment command again before ending the validation session.
Keep the previous package backup until the replacement is verified.

Stream Deck CLI success acknowledges deep-link submission, not host processing.
Deployment sends each stop/restart once and retries process/receipt checks for up
to 120 seconds per phase, reporting progress every 20 seconds. An already exited
runtime needs no new stop request. A process permission error is unknown, never
proof of exit. An existing installation with no valid runtime receipt is refused;
start a receipt-capable plugin in Stream Deck before retrying. On an unconfirmed
restart, keep the installation and package backup for inspection rather than
queueing a stop that could later kill the replacement.
