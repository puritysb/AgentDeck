#if os(macOS)
// DevicePairingWindow.swift — the Mac side of "get this device a credential".
//
// Two paths, because devices differ in what they can do, and for a long time
// only one of them was here:
//
//   • WITH A CAMERA (iPad / iPhone) — a QR of `ws://<lan-ip>:<port>?token=…`,
//     plus the same URL as selectable text for copy-paste. This is what the
//     window used to be, and all it was.
//   • NO CAMERA (e-ink readers, Android tablets) — a six-digit code from the
//     daemon's pairing window, typed on the device. The daemon and the Android
//     client have both implemented this the whole time; the only thing that
//     could open a window was `agentdeck pair`, a CLI the App Store build does
//     not ship. So a standalone user's reader had exactly one option left:
//     hand-typing a 32-hex-character token off the QR card. That is the gap
//     this half closes.
//
// QR payload = `AuthManager.getWsUrl(port:)` output, i.e.
//   ws://<lan-ip>:<port>?token=<token>

import SwiftUI
import CoreImage
import CoreImage.CIFilterBuiltins
import AppKit

struct DevicePairingWindow: View {
    @EnvironmentObject private var daemonService: DaemonService
    @EnvironmentObject private var preferences: AppPreferences
    @Environment(\.dismiss) private var dismiss

    @StateObject private var pairing = PairingCodeController()

    @State private var showCopiedToast: Bool = false
    /// Long enough to walk to a reader on the other side of the room and type
    /// six digits on an e-ink keyboard. The daemon's own default is 120s, which
    /// is sized for a CLI user standing at the device.
    @State private var ttlSeconds: Double = 600
    @State private var deviceCount: Int = 1

    private var port: Int {
        daemonService.port > 0 ? Int(daemonService.port) : preferences.daemonPort
    }

    /// Current daemon WebSocket URL with auth token. Re-evaluated whenever
    /// `daemonService.port` or the auth token changes so the QR keeps
    /// matching the live daemon state.
    private var pairingURL: String {
        AuthManager.shared.getWsUrl(port: port)
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                Text("Pair a device")
                    .font(HUDFont.title)

                Text("Approve a device that is already asking, or hand it a code.")
                    .font(HUDFont.body)
                    .foregroundStyle(TerrariumHUD.subtext)
                    .multilineTextAlignment(.center)

                knockSection
                Divider().opacity(0.25)
                cameraSection
                Divider().opacity(0.25)
                codeSection
                Divider().opacity(0.25)
                PairingRotationSettings(port: port)

                HStack {
                    Spacer()
                    Button("Close") { dismiss() }
                        .keyboardShortcut(.cancelAction)
                }
                .padding(.top, 4)
            }
            .padding(20)
        }
        .frame(width: 440, height: 720)
        .aquariumSurface()
        .onAppear { pairing.bind(portProvider: { port }) }
        .task {
            // Polls whether or not this window opened the pairing window, so a
            // window opened from `agentdeck pair` in a terminal shows up here
            // too. Loopback, once a second — cheaper than the QR re-render.
            while !Task.isCancelled {
                await pairing.refresh()
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    // MARK: - Approval path

    /// The path that asks nothing of the device. The daemon already refuses an
    /// unauthenticated peer and knows its address; this turns that refusal into
    /// a prompt. It is also the stronger trust model of the two on this window:
    /// a code trusts whoever knows a secret, an approval trusts a peer the
    /// operator pointed at, and an attacker cannot approve themselves.
    private var knockSection: some View {
        VStack(spacing: 10) {
            HUDSectionHeader(title: "WAITING TO CONNECT")

            if pairing.knocks.isEmpty {
                Text("Nothing is asking right now. A device appears here within seconds of trying to connect.")
                    .font(HUDFont.caption)
                    .foregroundStyle(TerrariumHUD.subtext)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                ForEach(pairing.knocks) { knock in
                    HStack(spacing: 8) {
                        VStack(alignment: .leading, spacing: 1) {
                            // The address, never a name the device chose for
                            // itself: at handshake time the IP is the only fact
                            // the daemon has, and a claimed name is attacker
                            // -controlled text.
                            Text(knock.ip)
                                .font(HUDFont.mono)
                                .foregroundStyle(.white)
                            Text(knock.detail)
                                .font(HUDFont.monoSmall)
                                .foregroundStyle(TerrariumHUD.subtext)
                        }
                        Spacer()
                        Button("Approve") { Task { await pairing.approve(knock.key) } }
                            .buttonStyle(.borderedProminent)
                            .controlSize(.small)
                            .disabled(pairing.busy)
                        Button("Dismiss") { Task { await pairing.dismiss(knock.key) } }
                            .buttonStyle(.borderless)
                            .controlSize(.small)
                            .tint(TerrariumHUD.subtext)
                            .disabled(pairing.busy)
                    }
                    .padding(.vertical, 4)
                    .padding(.horizontal, 8)
                    .background(Color.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 6))
                }
            }

            if !pairing.approvedPeers.isEmpty {
                DisclosureGroup("Approved (\(pairing.approvedPeers.count))") {
                    VStack(alignment: .leading, spacing: 4) {
                        // An approval keys on the address, so a DHCP lease change
                        // retires it and the device knocks again. Say so here
                        // rather than letting the row imply it follows the device.
                        Text("These connect without a token. A device-scoped grant follows the device; an address-scoped one retires when its DHCP address changes.")
                            .font(HUDFont.monoSmall)
                            .foregroundStyle(TerrariumHUD.subtext)
                            .fixedSize(horizontal: false, vertical: true)
                        ForEach(pairing.approvedPeers) { peer in
                            HStack {
                                Text(peer.label)
                                    .font(HUDFont.monoSmall)
                                    .foregroundStyle(peer.isAddressScoped ? TerrariumHUD.ledAmber : TerrariumHUD.subtext)
                                Spacer()
                                Button("Revoke") { Task { await pairing.revoke(peer.key) } }
                                    .buttonStyle(.borderless)
                                    .controlSize(.small)
                                    .tint(TerrariumHUD.ledAmber)
                                    .disabled(pairing.busy)
                            }
                        }
                    }
                    .padding(.top, 4)
                }
                .font(HUDFont.caption)
                .foregroundStyle(TerrariumHUD.subtext)
            }
        }
    }

    // MARK: - Camera path

    private var cameraSection: some View {
        VStack(spacing: 10) {
            HUDSectionHeader(title: "WITH A CAMERA")

            Text("On your iPad or iPhone, open AgentDeck and tap **Scan QR**.")
                .font(HUDFont.caption)
                .foregroundStyle(TerrariumHUD.subtext)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)

            // QR card keeps a white fill so iPad cameras can scan it — an
            // aquarium-tinted QR would lower contrast and break pairing.
            qrImage
                .frame(width: 220, height: 220)
                .background(
                    RoundedRectangle(cornerRadius: 12)
                        .fill(Color.white)
                )

            Text(pairingURL)
                .font(HUDFont.monoSmall)
                .foregroundStyle(TerrariumHUD.subtext)
                .textSelection(.enabled)
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .padding(.horizontal, 12)

            Button {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(pairingURL, forType: .string)
                showCopiedToast = true
                Task { @MainActor in
                    try? await Task.sleep(for: .seconds(1.5))
                    showCopiedToast = false
                }
            } label: {
                Label(showCopiedToast ? "Copied" : "Copy URL",
                      systemImage: showCopiedToast ? "checkmark.circle.fill" : "doc.on.doc")
                    .font(HUDFont.caption)
            }
            .buttonStyle(.borderless)
            .tint(showCopiedToast ? TerrariumHUD.ledGreen : TerrariumColors.tetraNeon)
        }
    }

    // MARK: - Code path

    private var codeSection: some View {
        VStack(spacing: 10) {
            HUDSectionHeader(title: "NO CAMERA")

            Text("For e-ink readers and Android tablets: enter this code on the device, in Settings → Pairing.")
                .font(HUDFont.caption)
                .foregroundStyle(TerrariumHUD.subtext)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)

            if let code = pairing.code {
                Text(PairingCodeRules.format(code))
                    .font(.system(size: 34, weight: .bold, design: .monospaced))
                    .foregroundStyle(.white)
                    .textSelection(.enabled)
                    .padding(.vertical, 6)

                Text(countdownLine)
                    .font(HUDFont.caption)
                    .foregroundStyle(TerrariumHUD.subtext)

                Button("Stop") { Task { await pairing.close() } }
                    .buttonStyle(.borderless)
                    .tint(TerrariumColors.tetraNeon)
                    .disabled(pairing.busy)
            } else if pairing.isOpen {
                // Someone else opened it — `agentdeck pair` in a terminal. The
                // code is returned only to whoever opened the window, so this
                // window can report the state but never reprint the digits.
                Text("A pairing window is already open elsewhere.")
                    .font(HUDFont.caption)
                    .foregroundStyle(.white)
                Text(countdownLine)
                    .font(HUDFont.caption)
                    .foregroundStyle(TerrariumHUD.subtext)
            } else {
                HStack(spacing: 10) {
                    Picker("", selection: $deviceCount) {
                        Text("1 device").tag(1)
                        Text("2 devices").tag(2)
                        Text("3 devices").tag(3)
                    }
                    .labelsHidden()
                    .frame(width: 110)

                    Picker("", selection: $ttlSeconds) {
                        Text("2 min").tag(120.0)
                        Text("10 min").tag(600.0)
                        Text("30 min").tag(1800.0)
                    }
                    .labelsHidden()
                    .frame(width: 90)
                }

                Button {
                    Task { await pairing.open(ttlSeconds: ttlSeconds, devices: deviceCount) }
                } label: {
                    Label("Show pairing code", systemImage: "number")
                        .font(HUDFont.caption)
                }
                .buttonStyle(.borderedProminent)
                .disabled(pairing.busy || port == 0)
            }

            if let error = pairing.error {
                Text(error)
                    .font(HUDFont.caption)
                    .foregroundStyle(TerrariumHUD.ledAmber)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }

            // The receipt outlives the window on purpose: a one-device window
            // closes itself the moment it succeeds, so without this the
            // successful case would look identical to nothing having happened.
            if !pairing.redemptions.isEmpty {
                VStack(spacing: 4) {
                    ForEach(pairing.redemptions) { row in
                        Label(row.label, systemImage: "checkmark.circle.fill")
                            .font(HUDFont.caption)
                            .foregroundStyle(TerrariumHUD.ledGreen)
                    }
                }
                .padding(.top, 2)
            }
        }
    }

    private var countdownLine: String {
        let mins = pairing.secondsRemaining / 60
        let secs = pairing.secondsRemaining % 60
        let clock = String(format: "%d:%02d", mins, secs)
        var line = "Expires in \(clock)"
        if pairing.attemptsRemaining > 0 {
            line += " · \(pairing.attemptsRemaining) tries left"
        }
        if pairing.failureCount > 0 {
            line += " · \(pairing.failureCount) wrong"
        }
        return line
    }

    /// Render a QR code for `pairingURL`. The CIImage is produced without blur
    /// so the result stays crisp when the iPad camera scans it;
    /// `interpolation(.none)` preserves pixel edges.
    @ViewBuilder
    private var qrImage: some View {
        if let nsImage = renderQR(content: pairingURL, size: 220) {
            Image(nsImage: nsImage)
                .interpolation(.none)
                .resizable()
                .scaledToFit()
                .padding(10)
        } else {
            Text("QR render failed")
                .font(HUDFont.caption)
                .foregroundStyle(TerrariumHUD.subtext)
        }
    }

    private func renderQR(content: String, size: CGFloat) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(content.utf8)
        filter.correctionLevel = "M"  // balance density vs recovery
        guard let output = filter.outputImage else { return nil }
        let scale = size / output.extent.width
        let scaled = output.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let context = CIContext()
        guard let cgImage = context.createCGImage(scaled, from: scaled.extent) else { return nil }
        return NSImage(cgImage: cgImage, size: NSSize(width: size, height: size))
    }
}
#endif
