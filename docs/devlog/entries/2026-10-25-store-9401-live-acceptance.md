# 2026-10-25 — Store 9401 live acceptance and host data consent

### Real Store identity matters

The automatic local deployment had installed development build 1.9.2/5.
App Store redownload installed 1.9.2/9401 as `AgentDeck 2.app` beside it. The
development app was preserved, and the original Store app was moved to the
canonical Applications path and relaunched. Its Store receipt, strict signature,
Sandbox entitlement and process path were verified. Executable SHA-256:
`b730880f02ae9a1397beaef267ccfdd7922a2119bd457ba74d8f10584cbdcac5`.
This was an actual Store installation, unlike the earlier Development-signed
derivative used before public release.

### Consent explained the first failed replay

After supported Node shutdown, Store PID 74202 reclaimed 9120 in 136.303 s.
The first live replay timed out before any assertion. A five-second sample
showed multiple cooperative workers waiting in `SecItemCopyMatching` while a
macOS security approval was pending. After the operator handled Keychain and
Bluetooth consent, health answered in 0.100 s, later 0.028 s. No source repair
was made. This observation identifies an approval-dependent stall; it does not
establish that every earlier UI timeout had this cause.

The same Store process then passed all 15 assertions in
`verify-swift-codex-live.mjs`, with 71 WebSocket roster frames. Own synthetic
roster rows were removed; labeled synthetic timeline evidence remains.

### Deck discovery had a distinct permission boundary

The Swift registry held the correct live PID/port, but Stream Deck still
reported no daemon after plugin restart. TCC recorded
`kTCCServiceSystemPolicyAppDataDetailed` denial for the Elgato and Ulanzi hosts.
Files and Folders showed each host's AgentDeck switch off. The operator enabled
only those two entries. Stream Deck then connected at
2026-10-24T15:43:51.399Z and registered both physical decks; D200H was connected.
Full Disk Access and unrelated app-data grants were unnecessary. The reusable
instructions are in the Stream Deck guide; this entry is the dated evidence.

### Acceptance scope

The operator reported normal Settings tab changes and 3D restoration,
Stream Deck+/D200H physical session/detail/BACK operation, and sleep/wake
recovery. No numeric input-to-paint or recovery duration was supplied. The
observer/power-log capture did not independently establish an OS suspend event;
sleep/wake remains an operator attestation rather than a telemetry measurement.
The observer had 158 health samples before shutdown, maximum 513 ms, with no
owner change. These samples are not UI latency measurements.

iDotMatrix and 11 serial boards were connected. Timebox Mini reported a BLE
connect timeout during Swift acceptance; it connected after the original
launchd-managed Node daemon was restored on 9120 (`84a9de8e009e`). It is not
included in the successful Store device scope. The bounded observer was stopped.
No mobile installation or firmware flash was performed for this macOS
acceptance, and the original full receipt was not retroactively attested.
