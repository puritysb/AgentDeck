# 2026-11-14 — Vobot TLS runtime and daemon custody measurements

The Mini Dock D1 with stock firmware 1.2.6 runs a customized MicroPython 1.20.
Its TLS wrapper accepted an expired leaf certificate even after setting the
RTC to the host's current UTC time. It rejected a wrong hostname and an
untrusted issuer. `getpeercert(True)` exposed the leaf DER, so a RAM-only client
could combine native chain/name checks with an operator-provisioned SHA-256
pin and chain validity interval, withholding the bearer token until both
checks passed. The four certificate cases then behaved as expected. This is
not evidence of tamper-resistant time: the device's clock can still undermine
expiry checks. Replacing native validation with pin-only trust was rejected.

The firmware does not export `asyncio.Stream`; assuming upstream MicroPython's
API failed on the device. A small nonblocking socket adapter was exercised in
RAM against actual Node HTTPS and Swift Network.framework TLS listeners.
Both produced a welcome, session roster and usage frame, then another roster
on repeated polling. Revoking the test credential caused both to refuse the
next request. These were isolated fixture servers, not installed-app TLS
acceptance or a Gallery release.

The serial console becomes usable after the daemon's serial suspend lease is
active and the USB data connection is re-established. Interrupting startup
also interrupts the vendor Wi-Fi bootstrap; the probe had to connect using
the existing on-device Wi-Fi configuration without exporting its password.
After restoring execution, the vendor changed the configuration's `OPTIONS`
section. Comparing the `NETWORK.WIFI` value separately confirmed it was
unchanged; a whole-file hash would have misreported a pairing change. The
installed application hashes and legacy pairing remained intact after RAM
checks, and opening AgentDeck again restored its operating connection.

For the tested macOS identity import, a PKCS#12 container using
`PBE-SHA1-3DES` imported successfully while the attempted AES container did
not. The server certificate also needed the server-auth extended key usage
for the native SSL trust policy. The PKCS#12 container cipher is distinct from
the negotiated TLS cipher; no TLS downgrade was introduced to accommodate the
container. Test identities and fixture credentials were kept outside git.

A separate-profile owner experiment used a real isolated Node daemon and the
compiled Swift credential store. Node shutdown transferred custody to the
native store before exit. A real Swift TLS listener then served the same port
and retained both the live credential and the revocation before yielding it
back to Node. Restarting Node first reproduced the case where
its local profile is an inactive replica while the native client holds the
newest authority. A fresh socket-bound challenge and native seal restored
Node's TLS listener; the original live credential continued to work, a
revoked credential stayed rejected, and an ordinary observer received no
private custody packet. Promoting a stale replica merely because the previous
process disappeared was rejected because it could revive revoked authority.
The test used temporary home/data directories, loopback-only ports and disabled
device modules; it did not replace the operating daemon.
