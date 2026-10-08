# CI wait release preparation

[Interactive concept comparison](index.html) follows the design sequence in
[issue #433](https://github.com/puritysb/AgentDeck/issues/433): four 2D concepts,
small-surface readings, concurrent waits and fail/retry/pass playback before a
3D asset is chosen. It is a sketch, not a device screenshot or accepted artwork.

The implementation uses hook invocation identity and preserves agent state.
A hook request carries unknown CI phase. Node may query an explicitly identified
GitHub run/PR/ref, or close a watcher that it previously observed in the correct
process tree. Missing credentials, a failed probe, a cancelled run and an
incomplete check list never imply successful checks. Commands and credentials
are not included in session rows.

The generated Swift tracker executes the same lifecycle fixtures as TypeScript.
The native daemon observes hook evidence without launching an external program.
Session boundaries and matching foreground tool endings clear waits; background requests
survive Stop. A 24-hour bound retires unconfirmed stale evidence. A process exit
or hook closure says that the wait ended, not that CI passed.

This increment does not complete #433: real harness callback receipts,
APME foreground wait-span accounting, the selected station artwork and dedicated
firmware/matrix views remain release acceptance items. Agents without command
input/invocation IDs are deliberately not inferred from project membership.

The complete open-issue release matrix is in [RELEASING.md](../../RELEASING.md).
