# Dot local journey prototype

An inert Korean product-review walkthrough. It models proposed onboarding, scoped
context sharing, request reports and revocation, and branches into denial,
offline, stale-report and expired-authorization scenarios. Every screen is labeled
as a pre-release proposal. It makes no network calls, reads no credentials, writes
no storage and changes no real connection. The 60-second autoplay uses static
screen cuts and can be paused; any user interaction stops it.

Open `index.html` with the repository design assets accessible, or build a portable
local bundle with the canonical fonts, token CSS and original app icon:

```sh
python3 experiments/dot-local-journey/build.py /path/to/new-output-directory
```

Open the output `index.html` in a browser. The adjacent ZIP includes the same files
and works offline; official documentation links require internet if followed.
The builder refuses to overwrite an existing destination.

The native CLI and isolated Swift-host feasibility result is measured evidence.
Installed local MCP exposure, GUI onboarding, production-app integration, device
rendering and public distribution remain separate gates. The example checklist
response in this prototype is scripted, not a new Dot execution result.

[Scenario evaluation](REVIEW.md) records the evaluation and its limits.
[Distribution evidence](../../docs/dot-distribution-decision.md) owns the current
technical claims. The source imports the canonical design assets rather than
maintaining a token or font copy; portable bundles copy them only at build time.
