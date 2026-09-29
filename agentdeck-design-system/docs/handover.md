---
id: system.handover
title: Agent Handover Contract
description: How agents locate ownership, change specifications, prove behavior, and leave a reviewable handover.
category: Engineering
locale: en
canonical: true
status: required
owner: Repository maintainers
reviewed: 2026-07-18
revision: 2026-07-18
source_of_truth: agentdeck-design-system/docs/handover.md
validators: [node scripts/build-design-system-viewer.mjs --check]
translations: [ko, ja]
---

# Agent Handover Contract

Use this contract whenever an agent changes a visual rule, device specification, product policy, or its validation.

## Ownership first

| Change                                       | Edit first                                        | Then update                                              |
| -------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------- |
| Color, type, spacing, radius, motion         | `design/tokens.css` or `DESIGN.md`                | Token mirrors, component rules, viewer example           |
| Reusable component                           | `design/components.css` + `DESIGN.md`             | Runtime implementation and visual specimen               |
| Device panel, chip, transport, support state | `docs/hardware-compatibility.md`                  | Domain operations guide and public Devices summary       |
| App Store capability or copy boundary        | `docs/appstore-feature-matrix.md`                 | `apple/APP_REVIEW_NOTES.md`, metadata, archive verifier  |
| Test claim                                   | `docs/testing.md`                                 | Test implementation, scenario mapping, Build Health note |
| Agent workflow                               | `AGENTS.md` and the repo skill SSOT | This handover only when ownership changes                |

## Change sequence

1. Read `AGENTS.md`, then the owner named in the table.
2. Update the canonical specification before its mirrors or presentation.
3. Implement the smallest runtime change that satisfies the specification.
4. Run the named validator and a runtime-level check that can actually fail on the behavior.
5. Update translations only after the English revision is final.
6. Record ownership changes and verification evidence in `DEVELOPMENT_LOG.md`.

## Evidence levels

| Level    | Evidence                                                    | Valid claim                                     |
| -------- | ----------------------------------------------------------- | ----------------------------------------------- |
| Contract | Frontmatter, schema, token-sync, lint, generated-file drift | Sources and mirrors agree                       |
| Runtime  | Unit, integration, snapshot, simulator, build               | Software behavior works in the tested runtime   |
| Device   | Physical boot, transport, input, latency, heap, refresh     | Hardware behavior works on the named device     |
| Release  | Signed archive and distribution verifier                    | The submitted artifact preserves release policy |

A build wrapper is not device evidence. A screenshot is not protocol evidence. A passing generated-file check is not runtime behavior.

## Handover payload

Leave the next agent five items:

- Canonical source changed.
- Mirrors or translations changed.
- Runtime surfaces affected.
- Validators run and their result.
- Known limitation or next physical check.

If any item is unknown, say so. Do not hide uncertainty behind a generic “tests passed” statement.
