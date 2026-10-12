#if os(iOS)
// QRScannerView.swift — iOS QR code scanner for AgentDeck pairing.
//
// Wraps AVCaptureSession in a UIViewControllerRepresentable so the SwiftUI
// `Settings` scan button can present it as a full-screen modal. On a
// successful scan the decoded string is delivered via `onScan` — callers
// validate the payload (expected `ws://ip:port?token=xxx`) and feed it to
// `AgentStateHolder.connectTo(url:)`.
//
// Permission handling: requests AVCaptureDevice authorization on first
// appearance. If the user has previously denied, shows an explanatory
// placeholder with a "Open Settings" button rather than an empty preview.
// Matches the NSCameraUsageDescription in Info.plist ("AgentDeck uses the
// camera to scan QR codes for bridge pairing.").

import SwiftUI
@preconcurrency import AVFoundation
import UIKit

struct QRScannerView: View {
    /// Called with the decoded QR payload on first successful scan. The
    /// scanner stops itself after delivering the value.
    var onScan: (String) -> Void
    /// Called when the user taps "Cancel" without scanning.
    var onCancel: () -> Void

    @Environment(\.scenePhase) private var scenePhase
    @State private var authorizationStatus: AVAuthorizationStatus = AVCaptureDevice.authorizationStatus(for: .video)

    var body: some View {
        ZStack {
            switch authorizationStatus {
            case .authorized:
                QRScannerRepresentable(onScan: onScan)
                    .ignoresSafeArea()
                overlay
            case .notDetermined:
                requestView
            case .denied, .restricted:
                deniedView
            @unknown default:
                deniedView
            }
        }
        .background(Color.black.ignoresSafeArea())
        .onAppear {
            authorizationStatus = AVCaptureDevice.authorizationStatus(for: .video)
            if authorizationStatus == .notDetermined {
                AVCaptureDevice.requestAccess(for: .video) { granted in
                    DispatchQueue.main.async {
                        authorizationStatus = granted ? .authorized : .denied
                    }
                }
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                // The scanner remains presented while Settings changes access.
                authorizationStatus = AVCaptureDevice.authorizationStatus(for: .video)
            }
        }
    }

    private var overlay: some View {
        VStack {
            HStack {
                Spacer()
                Button {
                    onCancel()
                } label: {
                    Text("Cancel")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 8)
                        .background(Color.black.opacity(0.55), in: Capsule())
                }
                .padding(16)
            }
            Spacer()
            Text("Point the camera at the QR code shown on your Mac.")
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(.white)
                .padding(.horizontal, 20)
                .padding(.vertical, 10)
                .background(Color.black.opacity(0.55), in: Capsule())
                .padding(.bottom, 40)
        }
    }

    private var requestView: some View {
        VStack(spacing: 12) {
            Image(systemName: "camera.viewfinder")
                .font(.system(size: 48))
                .foregroundStyle(.white.opacity(0.8))
            Text("Camera access is needed to scan the pairing QR.")
                .font(.system(size: 14))
                .foregroundStyle(.white.opacity(0.8))
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
        }
    }

    private var deniedView: some View {
        VStack(spacing: 14) {
            Image(systemName: "camera.slash")
                .font(.system(size: 48))
                .foregroundStyle(.white.opacity(0.8))
            Text("Camera access is disabled.")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(.white)
            Text("Enable it in Settings → AgentDeck → Camera to scan pairing QR codes.")
                .font(.system(size: 13))
                .foregroundStyle(.white.opacity(0.8))
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
            Button {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            } label: {
                Text("Open Settings")
                    .font(.system(size: 14, weight: .medium))
                    .padding(.horizontal, 20)
                    .padding(.vertical, 10)
                    .background(Color.white, in: Capsule())
                    .foregroundStyle(.black)
            }
            Button("Close", action: onCancel)
                .foregroundStyle(.white.opacity(0.7))
                .padding(.top, 4)
        }
    }
}

// MARK: - UIViewControllerRepresentable

private struct QRScannerRepresentable: UIViewControllerRepresentable {
    var onScan: (String) -> Void

    func makeUIViewController(context: Context) -> QRScannerViewController {
        let vc = QRScannerViewController()
        vc.onScan = onScan
        return vc
    }

    func updateUIViewController(_: QRScannerViewController, context: Context) {}
}

// MARK: - AVFoundation session wrapper

@MainActor
private final class QRScannerViewController: UIViewController, @preconcurrency AVCaptureMetadataOutputObjectsDelegate {
    var onScan: ((String) -> Void)?

    private var captureSession: AVCaptureSession?
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var hasDelivered: Bool = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        setupSession()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        if let session = captureSession, !session.isRunning {
            DispatchQueue.global(qos: .userInitiated).async { session.startRunning() }
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        captureSession?.stopRunning()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    private func setupSession() {
        let session = AVCaptureSession()
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input)
        else { return }
        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.frame = view.bounds
        preview.videoGravity = .resizeAspectFill
        view.layer.addSublayer(preview)

        self.captureSession = session
        self.previewLayer = preview

        DispatchQueue.global(qos: .userInitiated).async { session.startRunning() }
    }

    func metadataOutput(
        _: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from _: AVCaptureConnection
    ) {
        guard !hasDelivered else { return }
        guard let first = metadataObjects.compactMap({ $0 as? AVMetadataMachineReadableCodeObject }).first,
              first.type == .qr,
              let value = first.stringValue,
              !value.isEmpty
        else { return }
        hasDelivered = true
        captureSession?.stopRunning()
        // Tiny haptic cue on successful scan — matches the native Camera app
        // behavior. Running on main queue (metadata callback is dispatched
        // there by setMetadataObjectsDelegate queue:).
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        onScan?(value)
    }
}
#endif
