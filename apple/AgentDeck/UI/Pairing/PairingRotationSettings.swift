#if os(macOS)
import SwiftUI

struct PairingRotationSettings: View {
    let port: Int
    @StateObject private var controller = PairingCodeController()
    @State private var confirmation = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Pairing security").font(HUDFont.body)
            Text("Renew the active host’s pairing token. Its devices will disconnect and need to pair again. Offline, unreachable or older hosts may still accept the previous token; global revocation remains incomplete.")
                .font(HUDFont.caption).foregroundStyle(TerrariumHUD.subtext)
            HStack {
                Button("Renew pairing token…") { confirmation = true }
                    .disabled(port <= 0 || controller.renewalBusy)
                if controller.renewalBusy { ProgressView().controlSize(.small) }
            }
            if let status = controller.renewalStatus { Text(status).font(HUDFont.caption).foregroundStyle(TerrariumHUD.subtext) }
        }
        .onAppear { controller.bind(portProvider: { port }) }
        .onChange(of: port) { _, value in controller.bind(portProvider: { value }) }
        .confirmationDialog("Renew the active host’s pairing token?", isPresented: $confirmation) {
            Button("Renew token and disconnect devices", role: .destructive) {
                Task { await controller.renewPairingToken() }
            }
        } message: { Text("This renews only the active host. Global revocation is incomplete until every other host’s credentials are checked.") }
    }
}
#endif
