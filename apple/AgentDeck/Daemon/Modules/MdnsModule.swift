#if os(macOS)
// MdnsModule.swift — mDNS/Bonjour service advertisement
// Ported from bridge/src/modules/mdns-module.ts + bridge/src/mdns.ts

import Foundation
import Network

final class MdnsModule: DeviceModule, @unchecked Sendable {
    let name = "mdns"
    private var listener: NWListener?
    private let port: UInt16
    private let projectName: String
    private let agentType: String

    init(port: UInt16, projectName: String = "daemon", agentType: String = "daemon") {
        self.port = port
        self.projectName = projectName
        self.agentType = agentType
    }

    func start() async {
        do {
            let params = NWParameters.tcp
            guard let nwPort = NWEndpoint.Port(rawValue: port) else {
                DaemonLogger.shared.info("mDNS: Invalid port \(port)")
                return
            }
            let listener = try NWListener(using: params, on: nwPort)

            // Advertise Bonjour service. Never include the pairing token —
            // mDNS TXT is multicast (issue #145).
            // An instance name must be unique per network SEGMENT, and
            // "\(projectName)-\(port)" was the same string on every Mac in an
            // office. Host + user + port are the three ways two daemons on one
            // segment legitimately differ. Shape is generated from
            // shared/src/mdns-identity.ts so both daemons compute it alike.
            let shortHostname = MdnsIdentity.sanitizeLabel(ProcessInfo.processInfo.hostName)
            let userTag = MdnsIdentity.currentUserTag()
            let txtRecord = NWTXTRecord([
                "project": projectName,
                "agent": agentType,
                "port": "\(port)",
                "ip": AuthManager.getLanIP() ?? "127.0.0.1",
                // TXT schema version — keep in lockstep with the Node daemon's
                // advertisement (bridge/src/mdns.ts).
                "v": MdnsIdentity.txtSchemaVersion,
                // So a client can tell WHICH daemon this is without resolving
                // and dialling it. `user` is a hash, never the account name —
                // multicast is readable by everyone on the segment.
                "host": shortHostname,
                "user": userTag,
            ])

            listener.service = NWListener.Service(
                name: MdnsIdentity.instanceName(
                    project: projectName, hostname: shortHostname, userTag: userTag, port: Int(port)),
                type: "_agentdeck._tcp",
                txtRecord: txtRecord
            )

            listener.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    DaemonLogger.shared.info("mDNS: Advertising _agentdeck._tcp on port \(self.port)")
                case .failed(let error):
                    DaemonLogger.shared.error("mDNS failed: \(error)")
                default:
                    break
                }
            }

            // We don't need to accept connections on this listener — it's just for Bonjour
            listener.newConnectionHandler = { conn in
                conn.cancel() // Reject — WS server handles actual connections
            }

            listener.start(queue: .global(qos: .utility))
            self.listener = listener
        } catch {
            DaemonLogger.shared.error("mDNS: Failed to start: \(error)")
        }
    }

    func stop() async {
        listener?.cancel()
        listener = nil
    }

    /// Re-advertise after network change (IP change, VPN toggle, sleep/wake)
    func republish() async {
        await stop()
        await start()
    }
}
#endif
