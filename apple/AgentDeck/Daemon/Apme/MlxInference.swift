#if os(macOS)
import Foundation

enum MlxSafetyError: Error, LocalizedError {
    case refused(String)
    var errorDescription: String? { if case .refused(let reason) = self { return reason }; return nil }
}

/// One admission gate for judge, classifier, summary and readiness requests.
/// No task queue: optional background work yields when the shared GPU is busy.
/// The server must enforce cross-process admission; metrics are only a snapshot.
actor MlxInference {
    static let shared = MlxInference()
    typealias Transport = @Sendable (URLRequest) async throws -> (Data, URLResponse)
    private let transport: Transport
    private var active: Set<String> = []
    private var blockedUntil: [String: Date] = [:]

    init(transport: @escaping Transport = { try await URLSession.shared.data(for: $0) }) { self.transport = transport }

    nonisolated static func base(_ endpoint: String) throws -> String {
        guard var parts = URLComponents(string: endpoint), ["http", "https"].contains(parts.scheme ?? ""),
              parts.host != nil, parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil
        else { throw MlxSafetyError.refused("Invalid MLX endpoint") }
        var path = parts.path
        while path.hasSuffix("/") { path.removeLast() }
        for suffix in ["/v1/chat/completions", "/chat/completions", "/v1"] {
            if path.hasSuffix(suffix) { path.removeLast(suffix.count); break }
        }
        parts.path = path
        guard let result = parts.string else { throw MlxSafetyError.refused("Invalid MLX endpoint") }
        return result
    }

    private func probe(_ url: String) async throws -> (Int, Data) {
        guard let url = URL(string: url) else { throw MlxSafetyError.refused("Invalid MLX probe") }
        var request = URLRequest(url: url)
        request.timeoutInterval = MlxSafetyRules.probeTimeout
        let (data, response) = try await transport(request)
        guard let http = response as? HTTPURLResponse else { throw MlxSafetyError.refused("Invalid MLX response") }
        if http.statusCode == 404 || http.statusCode == 405 { return (http.statusCode, Data()) }
        guard (200..<300).contains(http.statusCode) else { throw MlxSafetyError.refused("MLX safety probe HTTP \(http.statusCode)") }
        return (http.statusCode, data)
    }

    func resolve(endpoint: String, pin: String?) async throws -> String {
        let base = try Self.base(endpoint)
        let (healthStatus, data) = try await probe(base + "/health")
        let health = healthStatus == 404 || healthStatus == 405 ? [:] : (try JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        if health.keys.contains("loaded_model") {
            let model = try MlxSafetyRules.select(loadedKnown: true, loaded: health["loaded_model"] as? String, catalog: [], requested: pin)
            let (metricsStatus, metricsData) = try await probe(base + "/metrics")
            let metrics = metricsStatus == 404 || metricsStatus == 405 ? [:] : (try JSONSerialization.jsonObject(with: metricsData)) as? [String: Any] ?? [:]
            if let reason = MlxSafetyRules.metricsProblem(metrics) { throw MlxSafetyError.refused(reason) }
            return model
        }
        for suffix in ["/v1/models", "/models"] {
            let (status, catalogData) = try await probe(base + suffix)
            if status == 404 || status == 405 { continue }
            let catalog = (try? JSONSerialization.jsonObject(with: catalogData)) as? [String: Any] ?? [:]
            let rows = catalog["data"] as? [[String: Any]] ?? []
            return try MlxSafetyRules.select(loadedKnown: false, loaded: nil, catalog: rows.compactMap { $0["id"] as? String }, requested: pin)
        }
        throw MlxSafetyError.refused("MLX resident model could not be verified")
    }

    func send(_ original: URLRequest) async throws -> (Data, URLResponse) {
        let base = try Self.base(original.url?.absoluteString ?? "")
        let now = Date()
        blockedUntil = blockedUntil.filter { $0.value > now }
        guard !active.contains(base), blockedUntil[base] == nil else {
            throw MlxSafetyError.refused("MLX inference paused: busy or recovering from a failed request")
        }
        guard active.count + blockedUntil.count < MlxSafetyRules.maxEndpoints else { throw MlxSafetyError.refused("MLX endpoint admission limit reached") }
        active.insert(base)
        defer { active.remove(base) }
        var posted = false
        do {
            guard let bodyData = original.httpBody,
                  var body = try JSONSerialization.jsonObject(with: bodyData) as? [String: Any]
            else { throw MlxSafetyError.refused("MLX requires a JSON body") }
            let model = try await resolve(endpoint: base, pin: MlxSafetyRules.pin(body["model"] as? String))
            body["model"] = model
            var request = original
            request.httpMethod = "POST"
            request.url = URL(string: base + "/chat/completions")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            try Task.checkCancellation()
            posted = true
            let (data, response) = try await transport(request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 500
            if status >= 500 || status == 429 { blockedUntil[base] = Date().addingTimeInterval(MlxSafetyRules.cooldown) }
            return (data, response)
        } catch {
            if posted { blockedUntil[base] = Date().addingTimeInterval(MlxSafetyRules.cooldown) }
            throw error
        }
    }
}
#endif
