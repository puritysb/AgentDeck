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
