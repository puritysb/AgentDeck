#if os(macOS)
// PairingKnockStore.swift — who tried to connect, and who the operator let in.
//
// The daemon already knew everything this needs: it refuses an unauthenticated
// LAN peer at the WebSocket handshake and logs the IP. What it did not do was
// tell anyone. So a device with no credential retried forever into a log nobody
// reads (measured on this machine: one reader knocked 116 times and then went
// quiet for three weeks; another is still knocking every few seconds), while the
// only ways to give it a credential asked the DEVICE to do something — scan a
// QR, type six digits, type a 32-character token. An e-ink reader can do none
// of them comfortably, and one with no camera cannot do the first at all.
//
// Turning the refusal into a prompt inverts that: the device does nothing, and
// the operator — who is holding the Mac — approves a peer they can see. That is
// also the stronger of the two trust models. A pairing code trusts whoever knows
// a secret, so anyone in range may guess at it while the window is open; an
// approval trusts a specific peer the operator pointed at, and an attacker
// cannot approve themselves.
//
// Three properties this file has to keep.
//
// **Identity is the device id when the client sends one, and the address only
// when it does not.** The refusal happens at the HTTP upgrade, before any frame
// — `client_register`, where a device says its name, arrives only after a socket
// exists — so the daemon must learn who this is from the handshake itself. A
// client that sends `x-agentdeck-device` is approved as that device: two
// devices behind one NAT are told apart, a DHCP lease change does not retire
// the grant, and one device can be revoked without touching the token the whole
// fleet shares.
//
// The address remains the key for clients that send no id, and that path must
// keep working: every device already in the field predates the header, and
// refusing them would turn an upgrade into a fleet-wide outage. An IP-keyed
// approval carries the old caveats — it retires when the lease changes, and
// behind NAT it is not an identity at all — so the UI labels which kind a row
// is instead of letting them read alike.
//
// Neither kind is proof. The link is plaintext `ws://`, so a device id in the
// handshake is replayable by a passive observer on the same segment — exactly
// as true of the `?token=` every paired device already carries. This is no
// weaker than what ships today; it buys granularity and revocation, not
// secrecy. Unforgeable identity needs a challenge-response over a channel that
// is not plaintext, which is separate work this does not pretend to.
//
// **A claimed name is never identity.** Nothing here reads one. If a name is
// ever surfaced it must sit beside the address, never instead of it.
//
// **Bounded, and expired on read.** A hostile peer must not be able to grow this
// list without limit, so it is capped and the oldest knock is dropped — which
// does mean a flood can push a real device out of view, and the cap is chosen
// high enough that a human notices the flood first. Expiry is evaluated when the
// list is read, never by a timer: a timer that fires late on a sleeping laptop
// would keep a stale knock alive past its promise, exactly as in
// PairingWindowStore.
//
// Lock-based rather than actor-isolated on purpose: the WebSocket accept path
// calls `isApproved` synchronously before it may upgrade, and an actor hop there
// would mean answering the handshake from a different turn. Same reasoning, and
// same shape, as AuthManager.

import Foundation

final class PairingKnockStore: @unchecked Sendable {

    static let shared = PairingKnockStore()

    /// A knock is worth showing for this long after its last attempt. Long
    /// enough that the operator can walk to the Mac; short enough that a device
    /// carried out of the building stops being offered.
    static let knockTTL: TimeInterval = 15 * 60

    /// Cap on simultaneously-tracked peers.
    static let maxKnocks = 12

    struct Knock: Sendable, Equatable {
        /// What an approval will be recorded against. `device:<id>` when the
        /// client identified itself, `ip:<addr>` otherwise — never the bare
        /// string, so the two can never collide or be confused downstream.
        let key: String
        let ip: String
        let deviceId: String?
        var attempts: Int
        var firstSeen: Date
        var lastSeen: Date
        /// True when the peer presented a token we do not accept, rather than no
        /// token at all. Reads very differently to an operator: usually a
        /// provisioned device whose credential went stale, not a new device.
        var staleToken: Bool

        var isDeviceScoped: Bool { deviceId != nil }
    }

    struct Approval: Sendable, Equatable, Codable {
        let key: String
        /// Where it last connected from. Display only — an approval keyed on a
        /// device id must not start depending on the address, or it would
        /// silently reacquire the NAT and DHCP problems it exists to escape.
        let lastIP: String
        let approvedAt: Date
        var credentialGeneration: String?

        var deviceId: String? {
            key.hasPrefix("device:") ? String(key.dropFirst("device:".count)) : nil
        }
    }

    /// The one place a key is spelled, so the gate, the store and the UI cannot
    /// disagree about what "this peer" means.
    static func peerKey(ip: String, deviceId: String?) -> String {
        if let deviceId, let normalized = PairingCodeRules.normalizeDeviceId(deviceId) {
            return "device:\(normalized)"
        }
        return "ip:\(ip)"
    }

    private let lock = NSLock()
    private var pending: [String: Knock] = [:]
    private var approved: [String: Approval]

    private init() {
        approved = Self.loadApprovals()
    }

    // MARK: - Knocks

    /// Called from the refusal path. Cheap on purpose — it runs for every
    /// rejected handshake, and a looping device produces one every few seconds.
    func record(ip: String, deviceId: String?, staleToken: Bool, now: Date = Date(), credentialGeneration: String? = nil) {
        guard !ip.isEmpty else { return }
        let normalizedId = PairingCodeRules.normalizeDeviceId(deviceId)
        let key = Self.peerKey(ip: ip, deviceId: normalizedId)
        lock.lock()
        defer { lock.unlock() }
        // Retired grants remain persisted, but cannot suppress a new request
        // for the operator to approve at the current credential generation.
        if let approval = approved[key], approval.credentialGeneration == credentialGeneration { return }
        if var existing = pending[key] {
            existing.attempts += 1
            existing.lastSeen = now
            existing.staleToken = staleToken
            pending[key] = existing
        } else {
            pending[key] = Knock(key: key, ip: ip, deviceId: normalizedId,
                                 attempts: 1, firstSeen: now,
                                 lastSeen: now, staleToken: staleToken)
            evictIfNeeded()
        }
    }

    /// Live knocks, newest first. Expiry is applied here — see the header.
    func knocks(now: Date = Date()) -> [Knock] {
        lock.lock()
        defer { lock.unlock() }
        pending = pending.filter { now.timeIntervalSince($0.value.lastSeen) < Self.knockTTL }
        return pending.values.sorted { $0.lastSeen > $1.lastSeen }
    }

    /// Drop a knock without approving it. Not a block: the peer may knock again,
    /// which is deliberate — a permanent denylist keyed on an IP a stranger can
    /// change is security theatre, and it would silently strand a real device
    /// that later inherits that address.
    func dismiss(key: String) {
        lock.lock()
        defer { lock.unlock() }
        pending.removeValue(forKey: key)
    }

    private func evictIfNeeded() {
        guard pending.count > Self.maxKnocks else { return }
        let ordered = pending.values.sorted { $0.lastSeen < $1.lastSeen }
        for knock in ordered.prefix(pending.count - Self.maxKnocks) {
            pending.removeValue(forKey: knock.key)
        }
    }

    // MARK: - Approvals

    /// Approving is what a pairing code would have done, minus the typing: from
    /// here on this peer authenticates by address. Persisted immediately.
    func approve(key: String, now: Date = Date(), credentialGeneration: String? = nil) {
        guard !key.isEmpty else { return }
        lock.lock()
        let lastIP = pending[key]?.ip ?? approved[key]?.lastIP ?? ""
        approved[key] = Approval(key: key, lastIP: lastIP, approvedAt: now, credentialGeneration: credentialGeneration)
        pending.removeValue(forKey: key)
        let snapshot = approved
        lock.unlock()
        Self.persist(snapshot)
    }

    func revoke(key: String) {
        lock.lock()
        approved.removeValue(forKey: key)
        let snapshot = approved
        lock.unlock()
        Self.persist(snapshot)
    }

    /// The question the WebSocket gate asks. Must stay allocation-light.
    ///
    /// A device id wins when the client sent one; the address is consulted only
    /// as the legacy path, so a client that adopts the header stops depending on
    /// its address the moment it does. Both are checked rather than one, because
    /// a device approved by address before it learned to send an id must not be
    /// locked out by the upgrade that taught it.
    func isApproved(ip: String, deviceId: String?, credentialGeneration: String? = nil) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if let normalized = PairingCodeRules.normalizeDeviceId(deviceId),
           let approval = approved["device:\(normalized)"], approval.credentialGeneration == credentialGeneration {
            return true
        }
        guard !ip.isEmpty else { return false }
        return approved["ip:\(ip)"].map { $0.credentialGeneration == credentialGeneration } ?? false
    }

    func approvals(credentialGeneration: String? = nil) -> [Approval] {
        lock.lock()
        defer { lock.unlock() }
        return approved.values.filter { $0.credentialGeneration == credentialGeneration }.sorted { $0.approvedAt > $1.approvedAt }
    }

    // MARK: - Persistence

    /// One shape written before approvals were keyed on a device: a bare
    /// address and a timestamp.
    private struct LegacyApproval: Codable {
        let ip: String
        let approvedAt: Date
    }

    private static func loadApprovals() -> [String: Approval] {
        guard let data = try? Data(contentsOf: AgentDeckPaths.pairingApproved) else { return [:] }
        let decoder = JSONDecoder()
        if let rows = try? decoder.decode([Approval].self, from: data) {
            return Dictionary(rows.map { ($0.key, $0) }, uniquingKeysWith: { _, newer in newer })
        }
        // Migrate rather than discard. A decode that merely fails reads as
        // "nobody is approved", which silently un-pairs every device the
        // operator already let in — the same failure the tmp+rename below
        // exists to prevent, arriving through the schema instead of the disk.
        if let legacy = try? decoder.decode([LegacyApproval].self, from: data) {
            let migrated = legacy.map {
                Approval(key: "ip:\($0.ip)", lastIP: $0.ip, approvedAt: $0.approvedAt)
            }
            let table = Dictionary(migrated.map { ($0.key, $0) }, uniquingKeysWith: { _, newer in newer })
            persist(table)
            return table
        }
        return [:]
    }

    private static func persist(_ approved: [String: Approval]) {
        let rows = approved.values.sorted { $0.approvedAt < $1.approvedAt }
        guard let data = try? JSONEncoder().encode(rows) else { return }
        let url = AgentDeckPaths.pairingApproved
        let tmp = url.appendingPathExtension("tmp")
        // tmp+rename, as everywhere else that writes the data dir: a truncated
        // approvals file reads as "nobody is approved" and silently locks the
        // whole fleet out.
        do {
            try data.write(to: tmp)
            _ = try FileManager.default.replaceItemAt(url, withItemAt: tmp)
        } catch {
            try? FileManager.default.removeItem(at: tmp)
        }
    }
}
#endif
