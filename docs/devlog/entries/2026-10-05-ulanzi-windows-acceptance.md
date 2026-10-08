# 2026-10-05 — Separate Ulanzi source acceptance from Windows hardware evidence

Issue #445 was fixed in #446 and delivered as Ulanzi 1.7.0. Windows hardware is
unavailable locally, so source completion and physical acceptance are tracked
separately rather than leaving a corrected bug open indefinitely.

The Windows Node 22/24/26 matrix now runs Ulanzi discovery/client tests plus two
real filesystem/HTTP/WebSocket cases: foreign registry PID with bidirectional
traffic, and registry-port rediscovery after a socket drop. No production daemon,
WSL guest, Studio runtime or hardware is involved. The verification catalogue
records that boundary. [Ulanzi verification](plugin-ulanzi/VERIFY.md) documents
the community checklist and affected-platform release criterion.

After the PR's gates pass, #445 can close as fixed while #449 retains external
Windows/WSL2/D200 acceptance. A confirmed regression reopens the bug or gets a
linked issue. Missing hardware alone does not hold unrelated releases.
