# 2026-10-20 — Screen sharing and Notification Center windows can obscure notification QA

With explicit approval for temporary notification changes,
the existing signed Debug candidate (1.9.1, local build 7902) was reused for a real
notification click test. No application code changed and no new binary was built.
The October 19 entry remains a record of the earlier, incomplete notification test.

Enabling AgentDeck notifications initially produced no visible banner. Scoped
`usernoted` logs showed a successful enqueue and stored notification, but interruption
was suppressed with `resolutionReason: display shared` and `displayShared`. Temporarily
allowing notifications during screen sharing changed the next result to
`interruptionSuppression: none` and `Presenting ... as banner`. An absent banner alone
did not establish an app delivery failure.

Computer-use inspection still selected Notification Center's weather widget window.
Switching windows with Command–grave exposed the actual notification dialog.
For the third synthetic B notification, clicking its body while AgentDeck was running
opened B's question and `TIMELINE · QA Attention B`. Protocol control focus remained
A. The isolated loopback fixture recorded zero incoming commands in every category
(read-only, mutating, and unknown); this measurement applies only to the fixture run.
At 21:38:43 KST, system logs recorded the contents action,
`foreground: true`, delivery to AgentDeck, and foreground activation of
`/Applications/AgentDeck.app`.

The click removed the delivered notification. Fixture reset cleared the waiting
state; subsequent cleanup found nothing left to delete. Notification settings were
visually restored to OFF, temporary banner style, and OFF during screen sharing.
The fixture exited successfully, the original installed build 5 was restored with
matching binary hashes and a valid signature, and the original `lastBridgeUrl` was
restored. The original app again displayed six sessions on port 9120; the deployment
lock was released.

This verifies notification navigation with an already running app. Launching a
terminated app by clicking a notification was outside this test's scope.
