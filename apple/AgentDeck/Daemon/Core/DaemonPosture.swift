#if os(macOS)
import Foundation

/// Network posture for the in-process daemon — how much of the LAN it may
/// touch. Behavioral mirror of `bridge/src/network-posture.ts` (roadmap
/// item 12): the two daemons share the axes and their meaning, but not a
/// generated contract, because their module sets differ (the Swift daemon has
/// no UDP beacon and its AdbModule is an in-process stub).
///
/// Two independent axes, deliberately not folded into one flag:
/// - `noDeviceModules` answers "may this daemon drive hardware?". Every device
///   module stays unregistered, USB serial included. The daemon still binds
///   all interfaces, so a paired phone/tablet companion keeps working.
/// - `loopbackOnly` answers "may this daemon be seen or heard on the LAN at
///   all?". It binds `127.0.0.1` and skips the Bonjour advertisement and every
///   module that talks to a network peer (Pixoo HTTP, Timebox/iDotMatrix BLE
///   pushes). USB serial survives — a board on a cable is not a network peer.
struct DaemonPosture: Equatable, Sendable {
    /// Bind `127.0.0.1` only and emit nothing onto the LAN.
    var loopbackOnly: Bool
    /// Every device module off, USB serial included.
    var noDeviceModules: Bool

    static let open = DaemonPosture(loopbackOnly: false, noDeviceModules: false)

    /// Modules that survive `loopbackOnly` because their transport is a USB
    /// cable, not the network. Node parity: `daemonModuleConfigs` keeps
    /// `serial` and `adb` under loopback (`adb` is a stub here, but keeping it
    /// listed means the two daemons answer "what runs under loopback?" the
    /// same way).
    static let usbChannelModules: Set<String> = ["serial", "adb"]

    /// Whether a device module named `name` may register under this posture.
    /// Deny-by-default in the restricted postures: a module added later and
    /// not listed in `usbChannelModules` fails safe as "off", never "on" —
    /// the same shape as Node's `{ ...allModulesOff(), <permitted> }`.
    func allowsModule(_ name: String) -> Bool {
        if noDeviceModules { return false }
        if loopbackOnly { return Self.usbChannelModules.contains(name) }
        return true
    }

    /// Whether the daemon may advertise `_agentdeck._tcp` over Bonjour.
    /// Off under loopback (advertising a loopback-bound listener would be the
    /// pre-fix Node bug in reverse: noise for a service nobody on the segment
    /// can reach) and off under noDeviceModules too — Node parity: `--local`
    /// forces the mdns module off with the rest of `allModulesOff()`. A paired
    /// companion still connects; it remembers its endpoint and doesn't need
    /// discovery.
    var advertisesOnLAN: Bool { !loopbackOnly && !noDeviceModules }

    /// Wire form for `/health`, matching the Node daemon's `posture` field so
    /// `agentdeck daemon restart` inheritance and the `qr`/`pair` "this daemon
    /// is loopback-only" warnings work against either daemon. Full-health
    /// payload only — the unauthenticated LAN `/health` stays minimal.
    var healthDict: [String: Any] {
        ["loopbackOnly": loopbackOnly, "noDeviceModules": noDeviceModules]
    }

    /// One startup line naming what is actually off (Node parity:
    /// `describeDaemonPosture`). The open line points at where the switch
    /// lives, which for this daemon is Settings, not an env var.
    func describe(port: UInt16) -> String {
        if loopbackOnly {
            let usb = noDeviceModules
                ? ", USB serial are all off."
                : " are all off; USB serial stays on."
            return "Loopback-only posture — bound to 127.0.0.1:\(port). "
                + "Bonjour advertisement, Pixoo LAN pushes, BLE device pushes\(usb) "
                + "LAN devices (companion apps, ESP32/WiFi boards) cannot connect."
        }
        if noDeviceModules {
            return "Listening on all interfaces (:\(port)) with every device module off "
                + "(no Bonjour, no Pixoo, no BLE, no serial). "
                + "LAN requests still require the pairing token."
        }
        return "Daemon listening on all interfaces (:\(port)) — LAN requests require the pairing token. "
            + "Settings → Local server offers a loopback-only posture with LAN discovery and device modules disabled."
    }
}
#endif
