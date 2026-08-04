#if os(macOS)
// IDotMatrixSheet.swift — User-facing iDotMatrix BLE device manager.
//
// iDotMatrix 32×32 pixel displays are Bluetooth-LE devices, identified by their
// advertised service UUID and known name families ("IDM-", "iPixel-") rather than a
// single vendor prefix. Unlike Pixoo (HTTP/IP), discovery is a CoreBluetooth scan. The user taps
// Scan, picks their device, and AgentDeck stores its CBPeripheral.identifier UUID under
// `idotmatrixDevices` in settings.json. IDotMatrixModule hot-reloads that array and
// drives the display over BLE — no Terminal, no Python.

import SwiftUI
import AppKit

struct IDotMatrixSheet: View {
    @Environment(\.dismiss) private var dismiss

    @State private var devices: [Entry] = []
    @State private var scanning = false
    @State private var scanResults: [IDotMatrixDiscovered] = []
    @State private var scanError: String?
    @State private var savingError: String?
    @State private var brightness: Double = 100

    // Held strongly for the duration of a scan.
    @State private var scanner: IDotMatrixBLE?

    struct Entry: Identifiable, Hashable {
        let id = UUID()
        let address: String
        let name: String?
        var brightness: Int?
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            header
            Divider()
            listSection
            Divider()
            scanSection
            Spacer()
            Divider()
            footer
        }
        .padding(20)
        .frame(width: 520, height: 540)
        .aquariumSurface()
        .onAppear(perform: loadDevices)
    }

    // MARK: - Sections

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "dot.radiowaves.left.and.right")
                .font(.system(size: 18))
                .foregroundStyle(Color.accentColor)
            VStack(alignment: .leading, spacing: 2) {
                Text("iDotMatrix LED Display")
                    .font(.system(size: 16, weight: .semibold))
                Text("Pair your iDotMatrix over Bluetooth. AgentDeck renders session state on it.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var listSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Paired Device")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.secondary)
            if devices.isEmpty {
                Text("No device yet. Scan below and pick your iDotMatrix.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 8)
            } else {
                ForEach(devices) { device in
                    deviceRow(device)
                }
                brightnessControl
            }
        }
    }

    private func deviceRow(_ device: Entry) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "square.grid.3x3.middle.filled")
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 1) {
                Text(device.name ?? "iDotMatrix")
                    .font(.system(size: 12, weight: .medium))
                Text(device.address)
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer()
            Button {
                removeDevice(device)
            } label: {
                Image(systemName: "trash")
                    .font(.system(size: 11))
                    .foregroundStyle(.red)
            }
            .buttonStyle(.borderless)
            .help("Unpair this device")
        }
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color.secondary.opacity(0.06)))
    }

    private var brightnessControl: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("Brightness: \(Int(brightness))%")
                .font(.system(size: 11)).foregroundStyle(.secondary)
            Slider(value: $brightness, in: 5...100, step: 5) { editing in
                if !editing { applyBrightness() }
            }
        }
        .padding(.top, 4)
    }

    private var scanSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Discover")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                Button {
                    startScan()
                } label: {
                    if scanning {
                        HStack(spacing: 6) { ProgressView().controlSize(.small); Text("Scanning…") }
                    } else {
                        Label("Scan", systemImage: "antenna.radiowaves.left.and.right")
                    }
                }
                .buttonStyle(.bordered)
                .disabled(scanning)
            }

            if let scanError {
                Label(scanError, systemImage: "xmark.circle.fill")
                    .font(.system(size: 11)).foregroundStyle(.red)
            }

            if scanResults.isEmpty && !scanning {
                Text("Tap Scan to find nearby iDotMatrix panels, including rebrands like iPixel.")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
            } else {
                ForEach(scanResults, id: \.id) { found in
                    HStack(spacing: 8) {
                        Image(systemName: "dot.radiowaves.right").foregroundStyle(.secondary)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(found.name).font(.system(size: 12, weight: .medium))
                            Text(found.id.uuidString)
                                .font(.system(size: 9, design: .monospaced))
                                .foregroundStyle(.secondary)
                                .lineLimit(1).truncationMode(.middle)
                        }
                        Spacer()
                        Button("Pair") { addDevice(found) }
                            .buttonStyle(.borderedProminent)
                            .controlSize(.small)
                            .disabled(devices.contains { $0.address == found.id.uuidString })
                    }
                    .padding(8)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Color.secondary.opacity(0.04)))
                }
            }

            if let savingError {
                Text(savingError).font(.system(size: 11)).foregroundStyle(.red)
            }
        }
    }

    private var footer: some View {
        HStack {
            Text("Changes are picked up automatically by the local daemon.")
                .font(.system(size: 10)).foregroundStyle(.secondary)
            Spacer()
            Button("Close") { dismiss() }.keyboardShortcut(.cancelAction)
        }
    }

    // MARK: - Scan

    private func startScan() {
        scanning = true
        scanError = nil
        scanResults = []
        let ble = IDotMatrixBLE()
        scanner = ble
        let extraPrefixes = loadExtraNamePrefixes()
        Task {
            do {
                try await ble.waitUntilReady(timeout: 6)
            } catch {
                await MainActor.run {
                    scanning = false
                    scanError = "\(error)"
                    scanner = nil
                }
                return
            }
            let found = await ble.scan(duration: 5, extraNamePrefixes: extraPrefixes)
            await MainActor.run {
                scanResults = found
                scanning = false
                scanner = nil
                if found.isEmpty {
                    scanError = "No iDotMatrix panels found. Make sure the display is powered on and nearby."
                }
            }
        }
    }

    // MARK: - I/O

    /// `idotmatrixNamePrefixes` from settings.json — the escape hatch for a panel
    /// that neither advertises the service nor uses a known brand name. The Node
    /// daemon reads the same key (`loadIDotMatrixNamePrefixes`).
    private func loadExtraNamePrefixes() -> [String] {
        guard let data = try? Data(contentsOf: AgentDeckPaths.settingsJson),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let arr = json["idotmatrixNamePrefixes"] as? [String] else { return [] }
        return arr.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }

    private func loadDevices() {
        guard let data = try? Data(contentsOf: AgentDeckPaths.settingsJson),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let arr = json["idotmatrixDevices"] as? [[String: Any]] else {
            devices = []
            return
        }
        devices = arr.compactMap { d in
            guard let address = d["address"] as? String else { return nil }
            return Entry(address: address, name: d["name"] as? String, brightness: d["brightness"] as? Int)
        }
        if let b = devices.first?.brightness { brightness = Double(b) }
    }

    private func addDevice(_ found: IDotMatrixDiscovered) {
        // Single active device (matches the module driving devices[0]); replace.
        let entry = Entry(address: found.id.uuidString, name: found.name, brightness: Int(brightness))
        let before = devices
        devices = [entry]
        if !saveDevices() { devices = before; return }
        NotificationCenter.default.post(name: .idotmatrixSettingsChanged, object: nil)
    }

    private func removeDevice(_ device: Entry) {
        let before = devices
        devices.removeAll { $0.id == device.id }
        if !saveDevices() { devices = before; return }
        NotificationCenter.default.post(name: .idotmatrixSettingsChanged, object: nil)
    }

    private func applyBrightness() {
        guard !devices.isEmpty else { return }
        devices = devices.map { var d = $0; d.brightness = Int(brightness); return d }
        if saveDevices() {
            NotificationCenter.default.post(name: .idotmatrixSettingsChanged, object: nil)
        }
    }

    @discardableResult
    private func saveDevices() -> Bool {
        let url = AgentDeckPaths.settingsJson
        var root: [String: Any] = [:]
        if let data = try? Data(contentsOf: url),
           let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            root = parsed
        }
        let arr: [[String: Any]] = devices.map { d in
            var obj: [String: Any] = ["address": d.address]
            if let name = d.name { obj["name"] = name }
            if let b = d.brightness { obj["brightness"] = b }
            return obj
        }
        root["idotmatrixDevices"] = arr
        do {
            let out = try JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys])
            try out.write(to: url, options: [.atomic])
            savingError = nil
            return true
        } catch {
            savingError = "Couldn't save: \(error.localizedDescription)"
            return false
        }
    }
}
#endif
