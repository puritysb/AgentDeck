#if os(macOS)
import Foundation
import Network

@DaemonActor
final class DeviceSecurityManager {
    let store: DeviceSecurityStore
    private var listener: DeviceTLSServer?
    private var state = "disabled"
    private var closed = false
    private var busy = false
    private let loopbackOnly: Bool
    private let snapshot: @DaemonActor @Sendable () -> (sessions: Any, usage: Any)
    init(directory: URL = AgentDeckPaths.baseDirectory, loopbackOnly: Bool,
         snapshot: @escaping @DaemonActor @Sendable () -> (sessions: Any, usage: Any)) {
        store = DeviceSecurityStore(directory: directory); self.loopbackOnly = loopbackOnly; self.snapshot = snapshot
    }
    var status: [String: Any] { ["version": 1, "state": state] }
    func start() async throws {
        guard !closed, !busy else { throw DeviceSecurityRules.Failure.unavailable }
        busy = true; defer { busy = false }
        listener?.stop(); listener = nil
        do {
            guard let config = try store.read() else { state = "disabled"; return }
            guard config.role == .owner else { state = "replica"; return }
            let identity = try DeviceTLSIdentity.load(pfx: Data(base64Encoded: config.pfx)!, password: config.password,
                caDER: Data(base64Encoded: config.caDER)!, hostname: config.hostname)
            state = "starting"
            let deadline = ContinuousClock.now.advanced(by: .milliseconds(DeviceSecurityRules.bindTimeoutMs))
            while ContinuousClock.now < deadline {
                guard !closed else { throw DeviceSecurityRules.Failure.unavailable }
                let candidate = DeviceTLSServer(); listener = candidate
                try candidate.start(identity: identity, port: UInt16(config.port), loopbackOnly: loopbackOnly, credentials: store.credentials, snapshot: snapshot)
                while !candidate.isReady && candidate.startupFailure == nil && ContinuousClock.now < deadline {
                    guard !closed else { candidate.stop(); throw DeviceSecurityRules.Failure.unavailable }
                    try await Task.sleep(for: .milliseconds(50))
                }
                if !closed, candidate.isReady { state = "listening"; return }
                let failure = candidate.startupFailure; candidate.stop()
                guard failure == NWError.posix(.EADDRINUSE) else { throw DeviceSecurityRules.Failure.unavailable }
                try await Task.sleep(for: .milliseconds(DeviceSecurityRules.bindRetryMs))
            }
            throw DeviceSecurityRules.Failure.unavailable
        } catch { listener?.stop(); listener = nil; state = "unavailable"; throw error }
    }
    func stop() { closed = true; listener?.stop(); listener = nil; state = "disabled" }
    private func response(_ value: Any, status: Int = 200) -> HTTPServer.HTTPResponse {
        guard JSONSerialization.isValidJSONObject(value), let body = try? JSONSerialization.data(withJSONObject: value) else {
            return .json(["error": "device-security-response-failed"], status: 503)
        }
        return .init(status: status, headers: ["Content-Type": "application/json", "Cache-Control": "no-store"], body: body)
    }
    func handle(_ request: HTTPServer.HTTPRequest, trustedLocalOwner: Bool) async -> HTTPServer.HTTPResponse {
        guard trustedLocalOwner else { return response(["error": "local-owner-required"], status: 403) }
        guard request.queryParams.isEmpty else { return response(["error": "invalid-target"], status: 400) }
        if request.method == "GET", request.path == "/device-security/status" { return response(status) }
        if request.method == "GET", request.path == "/device-security/identity" {
            do {
                guard let config = try store.read() else { return response(["error": "not-configured"], status: 404) }
                return response(["hostname": config.hostname, "port": config.port, "caDER": config.caDER])
            } catch { return response(["error": "device-security-unavailable"], status: 503) }
        }
        if request.method == "GET", request.path == "/device-security/devices" {
            do {
                let devices: [[String: Any]] = try (store.credentials.snapshot()?.devices ?? []).map {
                    ["id": $0.id, "name": $0.name, "scopes": $0.scopes, "createdAt": $0.createdAt, "revokedAt": $0.revokedAt.map { $0 as Any } ?? NSNull()]
                }
                return response(["devices": devices])
            } catch { return response(["error": "device-security-unavailable"], status: 503) }
        }
        guard request.method == "POST", !closed, !busy else { return response(["error": "device-security-busy"], status: 409) }
        guard let data = request.body, data.count <= DeviceSecurityRules.maxBytes,
              let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return response(["error": "invalid-body"], status: 400) }
        do {
            if request.path == "/device-security/install" {
                let config = try DeviceSecurityRules.configuration(data)
                _ = try DeviceTLSIdentity.load(pfx: Data(base64Encoded: config.pfx)!, password: config.password,
                    caDER: Data(base64Encoded: config.caDER)!, hostname: config.hostname)
                try store.install(config); try await start(); return response(status)
            }
            if request.path == "/device-security/start" { try await start(); return response(status) }
            guard state == "listening", try store.read()?.role == .owner else { return response(["error": "device-security-not-active-owner"], status: 409) }
            if request.path == "/device-security/issue" {
                guard let name = body["name"] as? String, let scopes = body["scopes"] as? [String] else { return response(["error": "invalid-device"], status: 400) }
                let issued = try store.credentials.issue(name: name, scopes: scopes)
                return response(["token": issued.token, "id": issued.device.id, "scopes": issued.device.scopes])
            }
            if request.path == "/device-security/revoke" {
                guard let id = body["id"] as? String else { return response(["error": "invalid-device"], status: 400) }
                return response(["revoked": try store.credentials.revoke(id)])
            }
            if request.path == "/device-security/seal" {
                guard let nonce = body["nonce"] as? String, DeviceCredentialRules.hex(nonce, count: 32) else { return response(["error": "invalid-nonce"], status: 400) }
                listener?.stop(); listener = nil
                let transfer = try store.seal(nonce: nonce); state = "replica"
                let transferObject = try JSONSerialization.jsonObject(with: JSONEncoder().encode(transfer), options: [.fragmentsAllowed])
                let encoded = try JSONSerialization.data(withJSONObject: ["pid": ProcessInfo.processInfo.processIdentifier, "transfer": transferObject])
                return .init(status: 200, headers: ["Content-Type": "application/json", "Cache-Control": "no-store"], body: encoded)
            }
            return response(["error": "not-found"], status: 404)
        } catch { return response(["error": "device-security-operation-failed"], status: 503) }
    }
}
#endif
