#if os(macOS)
// ESP32WifiOta.swift — WiFi OTA push to AgentDeck ESP32 boards over their
// daemon WebSocket. Swift port of performWifiEsp32Ota in
// bridge/src/daemon-server.ts (protocol: esp32_ota_begin/chunk/end/abort,
// acks routed by otaId). Keep the two implementations behaviorally aligned —
// the firmware's strict seq/offset cursor is the contract for both.

import Foundation
import CryptoKit

/// Drives one WiFi OTA transfer at a time. Owned by DaemonServer, which
/// injects target resolution and live-socket lookup so this type stays free
/// of roster bookkeeping and testable without Network.framework.
// Holds daemon state → runs on the daemon's executor. See DaemonActor.
@DaemonActor
final class ESP32WifiOtaManager {
    struct ResolvedTarget {
        let key: String
        let board: String
        let otaSupported: Bool
        let otaSlotSize: Int?
        let otaReason: String?
    }

    /// Sendable transfer summary — crosses back into the nonisolated HTTP
    /// route handler, which renders it as the Node-parity JSON payload.
    struct OtaResult: Sendable {
        let target: String
        let board: String
        let bytes: Int
        let chunks: Int
        let reconnectResends: Int
        let md5: String
    }

    enum OtaError: Error, LocalizedError {
        case busy
        case noTarget(String)
        case ambiguousTarget(String, [String])
        case notSupported(String, String?)
        case firmwareTooLarge(Int, Int)
        case boardOffline(String, stage: String)
        case ackTimeout(stage: String, seq: Int?)
        case boardError(String)

        var errorDescription: String? {
            switch self {
            case .busy:
                return "another OTA transfer is already in progress"
            case .noTarget(let t):
                return "No online WiFi ESP32 target matches \"\(t)\""
            case .ambiguousTarget(let t, let keys):
                return "Target \"\(t)\" is ambiguous: \(keys.joined(separator: ", "))"
            case .notSupported(let key, let reason):
                return "Target \(key) does not report OTA support\(reason.map { " (\($0))" } ?? "")"
            case .firmwareTooLarge(let size, let slot):
                return "Firmware is \(size) bytes, OTA slot is \(slot) bytes"
            case .boardOffline(let key, let stage):
                return "OTA \(stage): board \(key) offline (no live WS)"
            case .ackTimeout(let stage, let seq):
                return "OTA \(stage)\(seq.map { " #\($0)" } ?? "") timed out"
            case .boardError(let message):
                return message
            }
        }
    }

    /// Node parity — see the timeout rationale block in daemon-server.ts:
    /// TCP never loses a frame on a live socket, so a "timeout" means the
    /// board is stalled (flash-sector erase, WiFi-stack starvation) or the
    /// socket dropped and the board is reconnecting. Generous caps ride out
    /// the stall; resends happen only after a RECONNECT (fresh socket), never
    /// on the same live socket — that would desync the firmware's cursor.
    var beginAckTimeout: TimeInterval = 15
    var chunkAckTimeout: TimeInterval = 30
    var endAckTimeout: TimeInterval = 30
    var reconnectWait: TimeInterval = 20
    var maxReconnectResends = 12
    private static let chunkSize = 1024

    /// Resolve `target` (board name / "board:ip" key / IP) to a unique online
    /// board, throwing OtaError.noTarget / .ambiguousTarget otherwise.
    var resolveTarget: ((String) throws -> ResolvedTarget)?
    /// The target's CURRENTLY-registered live connection — re-resolved on
    /// every send because the board re-registers a fresh socket on a mid-OTA
    /// reconnect. Never capture a connection reference across awaits.
    var liveConnection: ((_ key: String) -> WebSocketConnection?)?
    /// Called after a successful transfer so the owner can drop the roster
    /// entry — the board reboots into the new image and re-registers fresh.
    var onTransferComplete: ((_ key: String) -> Void)?

    private struct Waiter {
        let stage: String
        let seq: Int?
        // Void, not the ack dict — nothing consumes the payload, and resuming
        // a continuation with a non-Sendable [String: Any] trips strict
        // concurrency sending checks.
        let continuation: CheckedContinuation<Void, Error>
    }

    private var waiters: [String: Waiter] = [:]
    private var timeoutTasks: [String: Task<Void, Never>] = [:]
    private(set) var transferInFlight = false

    /// Route an `esp32_ota_ack` / `esp32_ota_error` frame from a board.
    /// Returns true when the frame was an OTA reply (consumed), false to let
    /// the caller keep dispatching. Mirrors handleEsp32OtaReply (Node).
    @discardableResult
    func handleReply(_ msg: [String: Any]) -> Bool {
        guard let type = msg["type"] as? String,
              type == "esp32_ota_ack" || type == "esp32_ota_error" else { return false }
        guard let otaId = msg["otaId"] as? String, let waiter = waiters[otaId] else { return true }

        if type == "esp32_ota_error" {
            resolveWaiter(otaId: otaId) {
                $0.continuation.resume(throwing: OtaError.boardError(msg["error"] as? String ?? "esp32_ota_error"))
            }
            return true
        }

        // Stage/seq must match the in-flight wait — a stale ack (e.g. from a
        // frame the board processed right before a reconnect resend) must not
        // complete a different stage.
        guard (msg["stage"] as? String ?? "") == waiter.stage else { return true }
        if let expected = waiter.seq, (msg["seq"] as? Int) != expected { return true }

        resolveWaiter(otaId: otaId) { $0.continuation.resume(returning: ()) }
        return true
    }

    private func resolveWaiter(otaId: String, _ complete: (Waiter) -> Void) {
        guard let waiter = waiters.removeValue(forKey: otaId) else { return }
        timeoutTasks.removeValue(forKey: otaId)?.cancel()
        complete(waiter)
    }

    private func waitForAck(otaId: String, stage: String, seq: Int?, timeout: TimeInterval) async throws {
        try await withCheckedThrowingContinuation { continuation in
            waiters[otaId] = Waiter(stage: stage, seq: seq, continuation: continuation)
            timeoutTasks[otaId] = Task { [weak self] in
                try? await Task.sleep(for: .seconds(timeout))
                guard !Task.isCancelled, let self else { return }
                self.resolveWaiter(otaId: otaId) {
                    $0.continuation.resume(throwing: OtaError.ackTimeout(stage: stage, seq: seq))
                }
            }
        }
    }

    /// Wait up to `wait` for the target's live socket (rides out the ~3-4 s
    /// WiFi-flash coexistence reconnect gap).
    private func awaitLiveConnection(key: String, wait: TimeInterval) async -> WebSocketConnection? {
        let deadline = Date().addingTimeInterval(wait)
        var conn = liveConnection?(key)
        while conn == nil && Date() < deadline {
            try? await Task.sleep(for: .milliseconds(200))
            conn = liveConnection?(key)
        }
        return conn
    }

    /// Run a full OTA transfer. Throws OtaError; returns the transfer
    /// summary on success.
    func performOta(target: String, firmware: Data) async throws -> OtaResult {
        guard let resolveTarget, let liveConnection else {
            throw OtaError.boardError("OTA manager not wired")
        }
        guard !transferInFlight else { throw OtaError.busy }
        transferInFlight = true
        defer { transferInFlight = false }

        let resolved = try resolveTarget(target)
        guard resolved.otaSupported else {
            throw OtaError.notSupported(resolved.key, resolved.otaReason)
        }
        if let slot = resolved.otaSlotSize, firmware.count > slot {
            throw OtaError.firmwareTooLarge(firmware.count, slot)
        }

        let key = resolved.key
        let otaId = UUID().uuidString
        let md5 = Insecure.MD5.hash(data: firmware).map { String(format: "%02x", $0) }.joined()
        var reconnectResends = 0

        // Send one OTA frame and wait for its ack, following the board to a
        // fresh socket if it reconnects mid-flight. On an ack timeout, if a
        // NEW live socket appeared, the frame died with the old socket — the
        // firmware's otaRx cursor survived the reconnect, so resending the
        // same seq once is safe. A genuinely-gone board still fails after
        // `reconnectWait`.
        func sendAndAck(_ frame: [String: Any], stage: String, seq: Int?, timeout: TimeInterval) async throws {
            guard let conn = await awaitLiveConnection(key: key, wait: reconnectWait) else {
                throw OtaError.boardOffline(key, stage: stage)
            }
            guard let data = frame.jsonData else { throw OtaError.boardError("OTA frame encode failed") }
            conn.send(data)
            do {
                try await waitForAck(otaId: otaId, stage: stage, seq: seq, timeout: timeout)
            } catch {
                guard let fresh = await awaitLiveConnection(key: key, wait: reconnectWait),
                      fresh !== conn, reconnectResends < maxReconnectResends else { throw error }
                reconnectResends += 1
                DaemonLogger.shared.debug(
                    "Daemon",
                    "OTA \(key): \(stage)\(seq.map { " #\($0)" } ?? "") ack lost on dropped socket — resending on reconnected WS (resend \(reconnectResends))")
                fresh.send(data)
                try await waitForAck(otaId: otaId, stage: stage, seq: seq, timeout: timeout)
            }
        }

        do {
            try await sendAndAck(
                ["type": "esp32_ota_begin", "otaId": otaId, "size": firmware.count, "md5": md5],
                stage: "begin", seq: nil, timeout: beginAckTimeout)

            var offset = 0
            var seq = 0
            while offset < firmware.count {
                let end = min(offset + Self.chunkSize, firmware.count)
                let chunk = firmware.subdata(in: offset..<end)
                try await sendAndAck([
                    "type": "esp32_ota_chunk",
                    "otaId": otaId,
                    "seq": seq,
                    "offset": offset,
                    "data": chunk.base64EncodedString(),
                ], stage: "chunk", seq: seq, timeout: chunkAckTimeout)
                offset = end
                seq += 1
            }

            try await sendAndAck(["type": "esp32_ota_end", "otaId": otaId],
                                 stage: "end", seq: nil, timeout: endAckTimeout)
            onTransferComplete?(key)

            return OtaResult(
                target: key,
                board: resolved.board,
                bytes: firmware.count,
                chunks: seq,
                reconnectResends: reconnectResends,
                md5: md5)
        } catch {
            // Best-effort abort so the board frees its OTA slot cursor.
            if let conn = liveConnection(key),
               let data = (["type": "esp32_ota_abort", "otaId": otaId] as [String: Any]).jsonData {
                conn.send(data)
            }
            resolveWaiter(otaId: otaId) {
                $0.continuation.resume(throwing: OtaError.boardError("ota_aborted"))
            }
            throw error
        }
    }
}
#endif
