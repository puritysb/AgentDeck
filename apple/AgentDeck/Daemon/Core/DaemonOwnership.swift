#if os(macOS)
// DaemonOwnership.swift — which daemon owns this machine's port, as three
// states rather than two booleans.
//
// A Mac can be in exactly one of three topologies, and every AgentDeck feature
// has to behave in all three:
//
//   .none      no daemon — nothing is serving 9120 yet, or we just tore down
//   .selfOwned the in-process Swift daemon is bound (Tier 1, sandboxed)
//   .external  a terminal-managed Node daemon is bound and this app is its
//              WebSocket client (Tier 2 features become available)
//
// `DaemonService` used to carry this as two independent `@Published` booleans
// with a `didSet` on one of them, which made the *promotion* edge — external
// client becoming the owner — something inferred from a flag write rather than
// stated. There are ten write sites, and one of them is `stop()`: tearing the
// service down while in client mode wrote `false` and therefore reported a
// promotion that never happened, firing `clearRelayedUsageState()` and blanking
// the Claude quota, Codex rate limits, subscription rows and Antigravity status
// that the external daemon had relayed. `restart()` — which Settings uses for a
// port or posture change — goes through `stop()`, so a settings edit while
// connected to a Node daemon wiped every usage gauge.
//
// Naming the states makes the edge a property of the transition instead of a
// property of one boolean, and gives the three topologies something a test can
// drive as a sequence.

/// Which daemon currently owns this machine's port.
enum DaemonOwnership: Equatable {
    case none
    case selfOwned
    case external
}

/// Why ownership changed. The reason is not decoration: a teardown and a
/// promotion both leave `isUsingExternalDaemon == false`, and only the second
/// one is a promotion.
enum DaemonOwnershipChange: Equatable {
    /// The in-process daemon bound the port, or took over after the external
    /// one disappeared.
    case tookOwnership
    /// An external Node daemon was found and this app became its client.
    case becameClient
    /// The service is going away — quit, restart, or a listener failure that
    /// tears everything down before retrying. Never a promotion, whatever the
    /// previous state was.
    case toreDown
}

extension DaemonOwnership {
    /// The state this change lands in.
    func applying(_ change: DaemonOwnershipChange) -> DaemonOwnership {
        switch change {
        case .tookOwnership: return .selfOwned
        case .becameClient:  return .external
        case .toreDown:      return .none
        }
    }

    /// `true` only for the edge that hands this app data the external daemon
    /// used to relay — external client → owner. Tearing down is not a
    /// promotion even though it also ends the client relationship, and taking
    /// ownership from `.none` is a cold start, not a promotion: there was no
    /// relayed state to invalidate.
    func promotes(_ change: DaemonOwnershipChange) -> Bool {
        self == .external && applying(change) == .selfOwned
    }

    /// The app is serving its own daemon (Tier 1 surfaces active).
    var isSelfDaemon: Bool { self == .selfOwned }
    /// A separately-installed Node daemon is serving (Tier 2 surfaces active).
    var isUsingExternalDaemon: Bool { self == .external }
}
#endif
