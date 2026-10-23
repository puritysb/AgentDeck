# 2026-10-23 — Dashboard rendering queried an unused Keychain value

After the screen was unlocked, the installed macOS Debug 1.9.2/5 app from
`adea2ab9` opened Settings successfully five times. CUA action completion took
364–1,372 ms; the four warm opens took 364–600 ms. Six Settings section changes
also succeeded (113–393 ms per click; subsequent AX reads 419–970 ms). These
measurements include automation and accessibility overhead. They are not
input-to-paint latency, and the earlier 30-second timeout did not recur.

Concurrent native process samples nevertheless found a concrete app issue:
`MonitorScreen.setupNeededLayer` called `setupNeededItems`, which synchronously
read Anthropic Admin key presence on the main thread. The observed stack ends
in `SecItemCopyMatching`, a securityd XPC request and `mach_msg2_trap`.
The preceding 15-minute OSLog window contains 596 `SecItemCopyMatching` calls
on that main thread; the log alone does not attribute each call to a caller.
The value was not used: the setup descriptors contain Claude, Codex, OpenClaw
and Antigravity, while only the separate `anthropic-admin` evaluator case uses
that key-presence argument. The iOS helper already always returned false.

The fix removes that lookup and its private helper. Settings' actual Admin API
credential controls keep their existing asynchronous credential read. No new
cache, task, credential storage or global Keychain behavior is needed; the
dashboard never needed this secret-derived value in the first place.

The successful-operation samples mostly show Core Animation synchronization,
ordinary run-loop waits and SwiftUI graph updates. Keychain calls were observed
but not a sustained 30-second block. This establishes an unnecessary main-thread
IPC dependency, not the cause of every historical UI/automation timeout.
The earlier timeline grouping fix remains in place.

Local evidence in the persistent checkout:
`diagnostics/apple-xcode/20261023-191446/` and
`diagnostics/settings-latency-20261023/`. The latter contains a 40-second opening
sample, six 10-second repeat samples and a Settings navigation sample. In
`repeat-settings-6.sample.txt`, lines 2653–2677 show the Keychain call chain.
The app was PID 15426, launched at 12:51 KST; this is a Debug runtime observation,
not an acceptance claim about the signed Store build 9301.
