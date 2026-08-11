---
id: policy.ai-assisted-maintenance
title: AI-Assisted Maintenance
description: Human-owned policy and measurable workflows for using coding agents in public AgentDeck maintenance.
category: Project
locale: en
canonical: true
status: active
owner: Project maintainers
reviewed: 2026-08-11
revision: 2026-08-11
source_of_truth: docs/ai-assisted-maintenance.md
validators: [pnpm docs:check, pnpm test]
---

# AI-Assisted Maintenance

AgentDeck is developed with several coding agents and supports several agent
harnesses. Automation can increase maintainer capacity, but it does not own code,
make merge decisions, or replace verification. A human maintainer remains
accountable for every issue action, review, patch, release, and disclosure.

## Principles

- **Public OSS scope.** Sponsored or credited model usage is limited to AgentDeck
  and other repositories the maintainer owns or is authorized to review.
- **Human approval.** Agents may propose classifications, findings, tests, and
  patches. A person decides whether they are correct and whether to act on them.
- **No secret harvesting.** Prompts and artifacts must exclude credentials,
  private source code, private logs, personal data, and unpublished vulnerability
  details unless the selected service and disclosure process explicitly permit
  that data.
- **Provider-neutral evidence.** Reviews are judged by reproducible findings,
  tests, and project rules, not by which coding agent produced them.
- **Publish what is reusable.** Repository-owned prompts, skills, review rules,
  eval criteria, and non-sensitive aggregate results remain available to other
  open-source maintainers.

## Maintenance workflows

### Pull request review

Agents can review external and maintainer-authored pull requests for correctness,
tests, compatibility, security boundaries, and documentation drift. Reviews must
cite a file, behavior, or failing check. They do not approve or merge a pull
request and should avoid repeating style feedback already enforced by tools.

### Cross-language contract checks

AgentDeck mirrors protocol and layout rules across TypeScript, Swift, Kotlin, and
C++. Agent-assisted review focuses on semantic drift that ordinary formatting and
generated-file checks may miss. Any proposed repair still runs the canonical
generator and the relevant platform tests.

### Issue triage

Agents may suggest duplicate links, affected components, reproduction gaps, and
labels using public issue content. They do not close an issue or contact a reporter
without maintainer approval. Sensitive reports stay in the private process defined
by [the security policy](../SECURITY.md).

### Release and security review

Before a release, agents can compare code, documentation, manifests, compatibility
rules, and release notes across the npm, Apple, Android, Stream Deck, Ulanzi, and
ESP32 channels. Security-oriented review is restricted to authorized repositories
and prioritizes pairing, authentication, command dispatch, local-network exposure,
update delivery, and secret handling.

## Measurement

When a recurring agent-assisted workflow is enabled, maintainers should publish
aggregate results that distinguish activity from usefulness:

| Measure                                         | Why it matters                         |
| ----------------------------------------------- | -------------------------------------- |
| Pull requests and release diffs reviewed        | Coverage of the maintainer workflow    |
| Actionable findings accepted                    | Useful review output                   |
| Findings rejected or marked duplicate           | False-positive and repetition pressure |
| Tests or regressions added from findings        | Durable project improvement            |
| First-response and review turnaround            | Contributor experience                 |
| Reusable prompts, rules, or workflows published | Benefit beyond this repository         |

Download counts, repository traffic, and agent invocations are supporting context,
not substitutes for accepted findings or contributor outcomes.

## Current boundary

The repository does not require a paid model API to build, test, install, or use
AgentDeck. API-backed maintainer automation is opt-in and must degrade to the
existing human and deterministic CI workflow when credits, credentials, or a
provider are unavailable. End-user source code and sessions are never enrolled in
maintainer automation merely because they use AgentDeck.
