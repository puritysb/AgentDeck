# Security Policy

AgentDeck controls local coding-agent sessions and communicates with devices over
the local network. Reports involving authentication, pairing, command dispatch,
update delivery, secrets, or unintended network exposure are especially useful.

## Supported versions

Security fixes target the latest released build in each actively distributed
channel and the current `master` branch. Older target-specific patch releases may
not receive separate fixes; users should update to the newest release available
for their channel.

## Reporting a vulnerability

Please report vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/puritysb/AgentDeck/security/advisories/new).
Do not open a public issue with exploit details, credentials, tokens, private
source code, or identifying logs.

Include, when available:

- the affected component and version or commit;
- the operating system, device, and network assumptions;
- clear reproduction steps or a minimal proof of concept;
- the expected and observed security boundary;
- possible impact and any known mitigations.

The maintainers will acknowledge the report as soon as practical, investigate it,
and coordinate disclosure after a fix or mitigation is available. Please avoid
public disclosure while that work is in progress.

If private vulnerability reporting is unavailable, open a public issue containing
only a request for a private contact channel and no vulnerability details.

## Scope

Good-faith research against repositories, accounts, networks, and hardware you
own or are authorized to test is welcome. Do not access other people's sessions or
data, degrade services, use social engineering, or retain sensitive data beyond
what is necessary to demonstrate the issue.

Ordinary bugs without a security impact should use the public bug-report form.
