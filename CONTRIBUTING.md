# Contributing to AgentDeck

Thank you for helping improve AgentDeck. Contributions can be code, tests,
documentation, hardware verification, bug reports, or design feedback.

## Before opening a change

- Search the existing issues and pull requests first.
- Open an issue before a large feature or architectural change so the scope can
  be agreed before implementation begins.
- Use [GitHub's private reporting flow](SECURITY.md) for vulnerabilities. Do not
  include exploit details, credentials, or private logs in a public issue.
- Keep changes focused. Cross-platform sweeps are welcome when the behavior is
  genuinely shared, but unrelated cleanup should be a separate pull request.

## Development setup

AgentDeck is a pnpm workspace. The baseline toolchain is Node.js 22 or newer and
pnpm 11.5 or newer.

```bash
pnpm install
pnpm build
pnpm test
pnpm docs:check
```

Platform-specific prerequisites and validation commands live in
[the testing guide](docs/testing.md). Architecture and generated-mirror rules
live in [CLAUDE.md](CLAUDE.md); contributors using any coding agent should read
that file before editing the repository.

## Pull requests

A pull request should:

1. Explain the problem and the intended user impact.
2. Include tests or verification proportional to the risk.
3. Update documentation when behavior, setup, compatibility, or protocol shape
   changes.
4. Preserve generated mirrors and run their documented generators rather than
   editing generated files in isolation.
5. Call out hardware-only validation that maintainers still need to perform.

For Apple changes, preserve the App Store invariants in
[CLAUDE.md](CLAUDE.md#app-store-build-invariants) and update the feature matrix
before moving or adding functionality. For protocol changes, follow
[the compatibility policy](docs/wire-compatibility.md).

## AI-assisted contributions

AI assistance is welcome, but the human contributor remains accountable for the
entire change. Review generated code, run the relevant checks, remove secrets and
private data from prompts and artifacts, and disclose substantial AI assistance
in the pull request when it materially shaped the implementation.

Automated reviews are advisory. A maintainer or contributor must decide whether
each finding is correct before code is changed or merged. See
[AI-assisted maintenance](docs/ai-assisted-maintenance.md) for the repository's
maintenance policy and planned public workflows.

## Review and decision making

AgentDeck is maintainer-led. Design and implementation decisions are discussed in
public issues and pull requests whenever possible. The maintainers make the final
merge decision based on project scope, compatibility, security, maintenance cost,
and available hardware verification.

By contributing, you agree that your contribution is provided under the
[MIT License](LICENSE) and that you will follow the
[Code of Conduct](CODE_OF_CONDUCT.md).
