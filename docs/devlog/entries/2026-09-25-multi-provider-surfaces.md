# 2026-09-25 — Multi-provider usage surfaces

## Changes

- Stream Deck Classic/XL use their physical bottom-row capacity, with paging only on overflow. Five Claude/Codex/z.ai readings fit Classic together.
- Both SD+ usage LCDs allow explicit provider selection. The selected dial wins a collision; the peer moves to another provider. E2 can return to automatic activity selection with a hold. Provider preferences persist in Stream Deck settings.
- Pixoo's Node and Swift renderers show all three live providers and reserve the corresponding creature-safe area. Seven-day-only Claude readings remain visible.
- TC001 keeps the agent page and rotates live provider usage pages. Official provider marks accompany window labels and percentages; the activity dot stays present on usage pages. Window lengths come from the wire rather than primary/secondary assumptions; MCP retains its quantity label. Rendering uses bounded stack buffers, without new heap allocation. The host simulator uses the same firmware renderer.
- The connected tablet's daemon preference omitted Claude although fresh quota was arriving. Re-enabled Claude through `/dashboard/providers`, preserving the other displayed providers. No Android executable change was needed; an ADB screen capture confirmed all three provider rows and live percentages on the connected Lenovo tablet.

## Validation and delivery scope

- Node build/typecheck and all 307 Vitest files passed: 4,702 tests passed, two skipped.
- macOS Debug build succeeded. TC001 target firmware and host simulator built; provider frames were inspected.
- Protocol regeneration was clean; docs/catalog/token sync checks passed. Design lint retains the existing 89 source findings plus three generated-bundle findings in the built checkout.
- Release remains held. iOS installation is explicitly skipped. Source validation is separate from installation; no store submission, tag, or package publication was performed.

## Local installation and owner acceptance

Code is committed as `b23a0e1f` in draft [PR #379](https://github.com/puritysb/AgentDeck/pull/379); all nine CI checks passed. Local integration commit `bbd8e8e7` preserves the pre-existing IPS10 voice work. The local main branch is a development integration tree, not the release source.

On September 25 the owner requested installation. Built the integrated source, passed 106 focused regression tests, and deployed using the supported plugin and daemon lifecycle commands:

| Target | Installed receipt |
| --- | --- |
| Stream Deck / SD+ | Plugin PID 90735, bundle SHA-256 prefix `ab90fade4e43`; `pnpm plugin:check` confirmed source link and running bundle identity. |
| CLI daemon / Pixoo | Supervised PID 91248 on 9120, running and disk build `4a8ad5e2f9be`; Gateway connected, Pixoo online without failures. The live outgoing Pixoo frame contained all three provider rows. |
| TC001 | WiFi OTA transferred 1,433,056 bytes in 1,400 chunks. After reboot, fresh device information reported version 1.4.0, build `bbd8e8e7-dirty`, new uptime, sessions and usage. The dirty suffix reflects the local build tree and is not a release tag. |
| Android tablet | Existing application retained; Claude display preference restored and all three provider rows visually confirmed. |

The owner subsequently confirmed that the changes appear correctly applied and asked to retain them as next-release candidates while collecting more improvements. No public release, store upload or iOS installation occurred.

## Next release queue

- Include PR #379's Stream Deck, Pixoo and TC001 changes with the daemon recovery and Apple Dashboard emphasis already prepared in draft [PR #378](https://github.com/puritysb/AgentDeck/pull/378).
- D200H's existing two-Claude / one-Codex / two-z.ai arrangement remains the reference; this change does not require an Ulanzi plugin release or Android binary update.
- Reassess affected channel versions after the remaining improvements are selected. The provisional npm 1.4.3 / Apple 1.5.1 preparation is not authorization to publish, and Stream Deck/ESP32 versions are not yet assigned for this batch.
- Integrate from reviewed release branches, excluding unrelated local IPS10 voice experiments. Rebuild and verify the final combined commit; prior candidate and local-development receipts do not certify different executable inputs.
- Keep both PRs in draft until the owner asks to cut the release. iOS device installation remains waived for this round. No tag, registry publication, store upload or submission is authorized by this preparation request.
