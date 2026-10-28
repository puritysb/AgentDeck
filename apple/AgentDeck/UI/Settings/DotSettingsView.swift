#if os(macOS)
import SwiftUI
import UniformTypeIdentifiers
import AppKit

struct DotSettingsView: View {
    @State private var snapshot = DotHostSnapshot(available: false, status: "Stopped", origin: "", clientID: "", consents: [], grants: [], reports: [])
    @State private var origin = ""
    @State private var port = String(DotLocalMCP.port)
    @State private var replacingWithLocal = false
    @State private var redirect = "https://chatgpt.com/connector_platform_oauth_redirect"
    @State private var certificate: Data?
    @State private var certificateName = "No certificate selected"
    @State private var password = ""
    @State private var selectingCharacter = false
    @State private var selectingCertificate = false
    @State private var replacing = false
    @State private var message: String?
    @State private var busy = false
    @State private var profile = "desk"
    @State private var context = ""
    @State private var grantID = ""
    @State private var verifiedConsent: Set<String> = []

    var body: some View {
        GroupBox("Dot connection") {
            VStack(alignment: .leading, spacing: 12) {
                Text(snapshot.status).font(.callout)
                if snapshot.hosting && !snapshot.grants.contains(where: { $0.scopes.contains("agentdeck:report") }) {
                    Text("Not linked — approve a reporting client to share task activity.")
                        .font(.callout).foregroundStyle(.secondary)
                }
                HStack {
                    Button("Choose character image…") { selectingCharacter = true }
                    Button("Restore default character") { perform { try await DotAppearanceStore.reset() } }
                }.disabled(busy)
                if let appearance = snapshot.appearance {
                    HStack {
                        DotCharacterImage(appearance: appearance).frame(width: 64, height: 64)
                        Text("Selected character").font(.caption)
                    }
                }
                Text("Choose a static PNG, WebP or JPEG for AgentDeck. Status and relationship labels remain visible.").font(.caption).foregroundStyle(.secondary)
                Text("AgentDeck receives requests directly on this Mac. Hosting stops when AgentDeck stops or the Mac sleeps.")
                    .font(.caption).foregroundStyle(.secondary)
                if snapshot.available {
                    Button(snapshot.origin.hasPrefix("http://") ? "Reset local connection…" : "Set up local connection") {
                        replacingWithLocal = true
                        if snapshot.grants.isEmpty { configureLocal() } else { replacing = true }
                    }.disabled(busy)
                    Text("Start a connection from your approved ChatGPT client, then compare its code with the request below. This preview has not verified ordinary-user installation or automatic Dot tool access.")
                        .font(.caption).foregroundStyle(.secondary)
                    if !snapshot.origin.isEmpty {
                        HStack {
                            Text("MCP address: \(snapshot.origin)/mcp").textSelection(.enabled).font(.caption)
                            Button("Copy connection address") {
                                copy(snapshot.origin + "/mcp", message: "Connection address copied.")
                            }
                        }
                        Toggle("Resume host when AgentDeck starts", isOn: Binding(
                            get: { snapshot.resumeOnLaunch }, set: { enabled in perform { try await DotHost.shared.setResumeOnLaunch(enabled) } })).disabled(busy)
                    }
                    DisclosureGroup("Advanced HTTPS experiment") {
                        VStack(alignment: .leading, spacing: 8) {
                            TextField("Public HTTPS origin", text: $origin)
                            TextField("Local HTTPS port", text: $port)
                            TextField("Exact callback URL from ChatGPT", text: $redirect)
                            HStack {
                                Button("Choose certificate…") { selectingCertificate = true }
                                Text(certificateName).font(.caption)
                            }
                            SecureField("Certificate password", text: $password)
                            Text("Use a PKCS#12 certificate with its private key and trusted chain. Configure DNS and external access to this dedicated port; keep device port 9120 private.")
                                .font(.caption).foregroundStyle(.secondary)
                            Button("Save connection configuration") {
                                replacingWithLocal = false
                                if snapshot.grants.isEmpty { configure() } else { replacing = true }
                            }.disabled(certificate == nil || busy)
                            if !snapshot.clientID.isEmpty && snapshot.origin.hasPrefix("https://") {
                                Toggle("Resume HTTPS hosting when AgentDeck starts", isOn: Binding(
                                    get: { snapshot.resumeOnLaunch }, set: { enabled in perform { try await DotHost.shared.setResumeOnLaunch(enabled) } }))
                                    .disabled(busy)
                                Text("Client ID: \(snapshot.clientID)").textSelection(.enabled).font(.caption)
                                Button("Copy client secret") { Task { if let secret = await DotHost.shared.secret() { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(secret, forType: .string) } } }
                                Text("MCP address: \(snapshot.origin)/mcp").textSelection(.enabled).font(.caption)
                            }
                        }
                    }
                    HStack {
                        Button("Start host") { perform { try await DotHost.shared.start() } }.disabled(busy)
                        Button("Stop hosting") { perform { await DotHost.shared.stop() } }.disabled(busy)
                    }
                    ForEach(snapshot.consents) { consent in
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Connection request · \(consent.verificationCode)").font(.headline)
                            Text(consentClientLabel(consent)).font(.caption).textSelection(.enabled)
                            Text(consent.redirectURI).font(.caption).textSelection(.enabled)
                            Text(consent.scopes.joined(separator: ", ")).font(.caption)
                            Toggle("The code matches the connection request I started", isOn: Binding(
                                get: { verifiedConsent.contains(consent.id) }, set: { if $0 { verifiedConsent.insert(consent.id) } else { verifiedConsent.remove(consent.id) } }))
                            HStack {
                                Button("Allow this connection") { perform { try await DotHost.shared.approve(consent.id, allowed: true) } }
                                    .disabled(!verifiedConsent.contains(consent.id) || busy)
                                Button("Deny") { perform { try await DotHost.shared.approve(consent.id, allowed: false) } }.disabled(busy)
                            }
                        }
                    }
                    if !snapshot.grants.isEmpty {
                        Picker("Approved connection", selection: $grantID) {
                            ForEach(snapshot.grants) { grant in Text(String(grant.id.prefix(8))).tag(grant.id) }
                        }
                        TextField("Integration profile", text: $profile)
                        Text("Share only the context you want Dot to receive. OpenAI processes the shared context and results; the local connection does not use an AgentDeck publisher relay.").font(.caption)
                        Text("Context expires after 30 minutes. Results remain for up to seven days unless this connection is revoked; expired records are cleaned up while AgentDeck runs.")
                            .font(.caption).foregroundStyle(.secondary)
                        TextEditor(text: $context).frame(minHeight: 70, maxHeight: 130)
                        HStack {
                            Button(snapshot.origin.hasPrefix("http://") ? "Prepare shared request" : "Ask Dot for a briefing") {
                                let key = UUID().uuidString, shared = context, profile = profile, grant = grantID
                                perform { try await DotHost.shared.request(grant: grant, profile: profile, context: shared, key: key) }
                            }.disabled(busy || context.isEmpty || context.unicodeScalars.count > DotLimits.contextCharacters || grantID.isEmpty)
                            Button("Revoke connection", role: .destructive) { let grant = grantID; perform { try await DotHost.shared.revoke(grant) } }.disabled(busy || grantID.isEmpty)
                        }
                        Text("Revoking blocks future access and removes this connection’s saved requests and results from AgentDeck. It does not stop a running Dot task, revoke Dot’s separate Mac access or delete data already shared with OpenAI.")
                            .font(.caption).foregroundStyle(.secondary)
                        Text(snapshot.origin.hasPrefix("http://") ? "Copy a request reference below and paste it in Dot with access to this Mac. Preparing a request does not wake Dot; an approved connection alone does not verify the first result." : "In Dot, subscribe to agentdeck.briefing.requested for this profile and ask it to read, claim and report each request. Delivery is separate from completion.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                } else {
                    Text("Direct hosting is available while this app owns the local AgentDeck daemon.").font(.caption)
                }
                if let message { Text(message).font(.caption).foregroundStyle(.secondary) }
                if !snapshot.reports.isEmpty {
                    Divider()
                    Text("Briefing results").font(.headline)
                    ForEach(Array(snapshot.reports.prefix(20))) { request in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text("Request ID: \(request.id)").textSelection(.enabled).font(.caption)
                                if snapshot.origin.hasPrefix("http://") {
                                    Button("Copy request for Dot") {
                                        copy("Read AgentDeck request \(request.id) and its explicitly shared context, then claim it and report progress and completion for this request only.", message: "Request reference copied. Paste it in Dot with access to this Mac.")
                                    }.disabled(request.expiresAt <= Int(Date().timeIntervalSince1970 * 1000))
                                }
                            }
                            Text("\(request.profile) · Delivery: \(request.delivery)").font(.caption)
                            if let events = request.interactions, !events.isEmpty {
                                DotInteractionView(events: events, now: Int(Date().timeIntervalSince1970 * 1000))
                            }
                            if let report = request.report {
                                Text("Last report: \(Self.reportLabel(request, now: Int(Date().timeIntervalSince1970 * 1000))) · \(Date(timeIntervalSince1970: Double(report.receivedAt) / 1000).formatted())").font(.caption).foregroundStyle(.secondary)
                                Text(verbatim: Self.displayText(report.summary)).textSelection(.enabled)
                            } else { Text("No report received").font(.caption).foregroundStyle(.secondary) }
                            if request.expiresAt <= Int(Date().timeIntervalSince1970 * 1000) { Text("Request expired; this does not stop Dot.").font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                }
            }.padding(8)
        }
        .fileImporter(isPresented: $selectingCharacter, allowedContentTypes: [.image]) { result in
            do {
                let url = try result.get(); let granted = url.startAccessingSecurityScopedResource()
                defer { if granted { url.stopAccessingSecurityScopedResource() } }
                let values = try url.resourceValues(forKeys: [.fileSizeKey])
                guard (values.fileSize ?? Int.max) <= DotAppearanceRules.sourceBytes else { throw DotFailure.message("Character image is too large.") }
                let data = try Data(contentsOf: url)
                perform { try await DotAppearanceStore.importImage(data) }
            } catch { message = error.localizedDescription }
        }
        .fileImporter(isPresented: $selectingCertificate, allowedContentTypes: [.data]) { result in
            do {
                let url = try result.get(); let granted = url.startAccessingSecurityScopedResource(); defer { if granted { url.stopAccessingSecurityScopedResource() } }
                let values = try url.resourceValues(forKeys: [.fileSizeKey])
                guard (values.fileSize ?? Int.max) <= 1048576 else { throw DotFailure.message("Certificate file is too large.") }
                certificate = try Data(contentsOf: url); certificateName = url.lastPathComponent; message = nil
            } catch { message = error.localizedDescription }
        }
        .confirmationDialog("Replace connection settings and revoke existing connections?", isPresented: $replacing) {
            Button("Replace connections", role: .destructive) { if replacingWithLocal { configureLocal() } else { configure() } }
        }
        .task {
            while !Task.isCancelled {
                snapshot = await DotHost.shared.snapshot()
                if origin.isEmpty { origin = snapshot.origin }
                if !snapshot.grants.contains(where: { $0.id == grantID }) { grantID = snapshot.grants.first?.id ?? "" }
                verifiedConsent.formIntersection(Set(snapshot.consents.map(\.id)))
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }
    private func configureLocal() {
        perform {
            try await DotHost.shared.configureLocal()
            try await DotHost.shared.start()
        }
    }
    private func copy(_ value: String, message: String) {
        NSPasteboard.general.clearContents()
        if NSPasteboard.general.setString(value, forType: .string) { self.message = message }
        else { self.message = "Could not copy. Select and copy the reference text instead." }
    }
    /// Report freshness uses the same generated rules as the companion surfaces.
    nonisolated static func reportLabel(_ request: DotBriefing, now: Int) -> String {
        let report = DotSurfaceSnapshot(configured: true, hosting: true, authorized: true,
            reportState: request.report?.state, reportedAt: request.report?.receivedAt, expiresAt: request.expiresAt)
        return DotAppearanceRules.labels[report.phase(at: now)].capitalized
    }
    /// A registered client named itself; only a metadata document's host vouches for the name.
    private func consentClientLabel(_ consent: DotConsent) -> String {
        switch consent.clientKind {
        case .preregistered: return consent.clientName
        case .registered: return "\(consent.clientName) · name reported by the app, not verified"
        case .metadata: return "\(consent.clientName) · published by \(URL(string: consent.clientID)?.host ?? consent.clientID)"
        }
    }
    private func configure() {
        guard let certificate, let port = UInt16(port) else { message = "Choose a certificate and valid port."; return }
        let origin = origin, redirect = redirect, password = password
        perform { try await DotHost.shared.configure(origin: origin, port: port, redirect: redirect, certificate: certificate, password: password) }
    }
    private func perform(_ operation: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }; busy = true; message = nil
        Task { @MainActor in
            defer { busy = false }
            do { try await operation(); snapshot = await DotHost.shared.snapshot() }
            catch { message = error.localizedDescription }
        }
    }
    nonisolated static func displayText(_ value: String) -> String {
        String(String.UnicodeScalarView(value.unicodeScalars.filter {
            $0.value == 10 || $0.value == 9 || ($0.properties.generalCategory != .control && $0.properties.generalCategory != .format)
        }))
    }
}
#endif
