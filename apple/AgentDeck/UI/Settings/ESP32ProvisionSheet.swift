#if os(macOS)
// ESP32ProvisionSheet.swift — User-facing Wi-Fi setup for ESP32 boards.
//
// The sheet hands the credentials to AgentDeck's daemon — the in-process one,
// or the one this app is a client of — through `POST /esp32/wifi`
// (ESP32WifiSetupClient). The daemon saves them and sends a `wifi_provision`
// to every ESP32 on USB serial, and with auto-send on, boards plugged in later
// get them from the saved config. The sheet then shows each board's answer.
//
// Before this, the sheet wrote a `wifi.config` frame straight to the first
// serial port it found — a message no firmware has ever parsed — on a port the
// daemon was holding, and nothing in the app saved credentials for its daemon.
//
// SSID and password are typed by the user: a Wi-Fi picker would need CoreWLAN
// and Location Services, and the App Sandbox blocks the `networksetup` /
// `security` subprocesses anyway. The password is never read back from the
// daemon, so changing anything means typing it again.

import SwiftUI

struct ESP32ProvisionSheet: View {
    /// The port of the daemon this app runs or is a client of; 0 = none.
    let daemonPort: Int

    @Environment(\.dismiss) private var dismiss

    @State private var status: ESP32WifiStatus?
    @State private var loading = false
    @State private var loadError: String?
    @State private var ssid = ""
    @State private var password = ""
    @State private var autoProvision = true
    @State private var applying = false
    @State private var applyError: String?
    @State private var lastApply: ESP32WifiApplyResult?
    @State private var applyTask: Task<Void, Never>?
    @State private var watchTask: Task<Void, Never>?

    /// Seconds the sheet keeps asking for answers from the boards it sent to:
    /// as long as the daemons hold a provision owed its ack.
    private static let ackWatchSeconds = ESP32WifiProvisionRules.ackTimeoutMs / 1000

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            Divider()
            content
            Spacer(minLength: 0)
            Divider()
            footer
        }
        .padding(20)
        .frame(width: 500, height: 540)
        .aquariumSurface()
        .task { await load(prefill: true) }
        .onDisappear {
            // Neither may outlive the sheet: each asks the daemon again with its token.
            applyTask?.cancel()
            watchTask?.cancel()
        }
    }

    // MARK: - Sections

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "antenna.radiowaves.left.and.right")
                .font(.system(size: 18))
                .foregroundStyle(Color.accentColor)
            VStack(alignment: .leading, spacing: 2) {
                Text("ESP32 Wi-Fi Setup")
                    .font(.system(size: 16, weight: .semibold))
                Text("AgentDeck saves these credentials and sends them to ESP32 boards on USB.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        if let status {
            credentialsForm(status)
            Divider()
            boardsSection(status)
        } else if let loadError {
            VStack(alignment: .leading, spacing: 10) {
                Label(loadError, systemImage: "exclamationmark.triangle.fill")
                    .font(.system(size: 12))
                    .foregroundStyle(DesignTokens.UI.attn)
                    .fixedSize(horizontal: false, vertical: true)
                HStack {
                    Spacer()
                    Button("Try Again") { Task { await load(prefill: true) } }
                        .buttonStyle(.bordered)
                        .disabled(loading)
                }
            }
        } else {
            HStack(spacing: 8) {
                ProgressView()
                    .controlSize(.small)
                Text("Checking ESP32 boards…")
                    .font(.system(size: 13))
            }
        }
    }

    private func credentialsForm(_ status: ESP32WifiStatus) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Wi-Fi network name")
                    .font(.system(size: 12, weight: .medium))
                TextField("MyNetwork", text: $ssid)
                    .textFieldStyle(.roundedBorder)
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("Wi-Fi password")
                    .font(.system(size: 12, weight: .medium))
                SecureField(status.configured ? "Type it again to send" : "Password for this network", text: $password)
                    .textFieldStyle(.roundedBorder)
            }
            Toggle("Also send to boards plugged in later", isOn: $autoProvision)
                .toggleStyle(.checkbox)
                .font(.system(size: 12))
            if let message = visibleProblem ?? applyError {
                Text(message)
                    .font(.system(size: 11))
                    .foregroundStyle(DesignTokens.UI.error)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func boardsSection(_ status: ESP32WifiStatus) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Boards on USB")
                .font(.system(size: 12, weight: .medium))
            if !status.serial {
                note("AgentDeck isn't managing USB boards right now, so credentials are saved without being sent.")
            } else if status.boards.isEmpty {
                note(autoProvision
                     ? "No ESP32 is connected over USB. A board plugged in later receives the saved credentials."
                     : "No ESP32 is connected over USB.")
            } else {
                ForEach(status.boards) { board in
                    boardRow(board)
                }
            }
        }
    }

    private func boardRow(_ board: ESP32WifiStatus.Board) -> some View {
        let line = ESP32WifiBoardLine.describe(board, outcome: lastApply?.boards.first { $0.port == board.port })
        return HStack(alignment: .top, spacing: 8) {
            Circle()
                .fill(tone(line))
                .frame(width: 8, height: 8)
                .padding(.top, 4)
            VStack(alignment: .leading, spacing: 1) {
                Text(board.board.isEmpty ? (board.port as NSString).lastPathComponent : board.board)
                    .font(.system(size: 12, weight: .medium, design: .monospaced))
                Text(line.text)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var footer: some View {
        HStack {
            if let lastApply {
                Text(summary(lastApply))
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button(lastApply == nil ? "Cancel" : "Done") { dismiss() }
                .keyboardShortcut(.cancelAction)
            Button(sendsNow ? "Save & Send" : "Save") { apply() }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(applying || status == nil
                          || ESP32WifiProvisionRules.credentialsProblem(ssid: ssid, password: password) != nil)
        }
    }

    private func note(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 11))
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: - Derived state

    /// The shared credential rule's verdict, once there is a password to judge.
    private var visibleProblem: String? {
        guard !password.isEmpty else { return nil }
        return ESP32WifiProvisionRules.credentialsProblem(ssid: ssid, password: password)
            .flatMap(ESP32WifiSetupClient.credentialsMessage)
    }

    private var sendsNow: Bool {
        guard let status else { return false }
        return status.serial && !status.boards.isEmpty
    }

    private func summary(_ result: ESP32WifiApplyResult) -> String {
        let sent = result.boards.filter(\.sent).count
        return result.boards.isEmpty ? "Saved." : "Saved · sent to \(sent) of \(result.boards.count) board(s)."
    }

    private func tone(_ line: ESP32WifiBoardLine) -> Color {
        switch line {
        case .ok: return DesignTokens.UI.ok
        case .waiting: return DesignTokens.UI.attn
        case .failed: return DesignTokens.UI.error
        case .neutral: return DesignTokens.UI.idle
        }
    }

    // MARK: - Actions

    private func load(prefill: Bool) async {
        guard daemonPort > 0 else {
            loadError = "AgentDeck's daemon isn't running."
            return
        }
        loading = true
        defer { loading = false }
        do {
            let next = try await ESP32WifiSetupClient.status(port: daemonPort)
            status = next
            loadError = nil
            if prefill, next.configured {
                if ssid.isEmpty { ssid = next.ssid }
                autoProvision = next.autoProvision
            }
        } catch {
            if status == nil { loadError = error.localizedDescription }
        }
    }

    private func apply() {
        guard !applying else { return }
        applying = true
        applyError = nil
        let request = (ssid: ssid, password: password, autoProvision: autoProvision)
        applyTask = Task {
            defer { applying = false }
            do {
                let result = try await ESP32WifiSetupClient.apply(
                    port: daemonPort, ssid: request.ssid, password: request.password,
                    autoProvision: request.autoProvision)
                if Task.isCancelled { return }
                lastApply = result
                await load(prefill: false)
                // A watch started after the sheet closed would never be cancelled.
                if Task.isCancelled { return }
                watchAcks(Set(result.boards.filter(\.sent).map(\.port)))
            } catch {
                if !Task.isCancelled { applyError = error.localizedDescription }
            }
        }
    }

    /// Re-reads the boards once a second until every board this send reached
    /// has answered, or `ackWatchSeconds` pass.
    private func watchAcks(_ ports: Set<String>) {
        watchTask?.cancel()
        guard !ports.isEmpty else { return }
        watchTask = Task {
            for _ in 0..<Self.ackWatchSeconds {
                try? await Task.sleep(for: .seconds(1))
                if Task.isCancelled { return }
                guard let next = try? await ESP32WifiSetupClient.status(port: daemonPort) else { continue }
                status = next
                let waiting = next.boards.contains { ports.contains($0.port) && $0.ack == nil }
                if !waiting { return }
            }
        }
    }
}
#endif
