#if os(macOS)
import Foundation

struct GitHubCIIdentity: Hashable, Sendable {
    let repo: String
    let run: Int?
    let pr: Int?
    let ref: String?
    static func repository(_ value: String) -> String? {
        let parts = value.split(separator: "/", omittingEmptySubsequences: false)
        guard value.utf8.count <= GitHubCIPolicy.maxIdentityChars, parts.count == 2,
              parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }),
              value.range(of: GitHubCIPolicy.repoPattern, options: .regularExpression)?.upperBound == value.endIndex else { return nil }
        return value.lowercased()
    }
    static func integer(_ value: Any?, allowZero: Bool = false) -> Int? {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(),
              n.doubleValue >= (allowZero ? 0 : 1), n.doubleValue <= GitHubCIPolicy.maxId,
              n.doubleValue.rounded() == n.doubleValue else { return nil }
        return n.intValue
    }
    init?(_ value: [String: Any]) {
        guard let raw = value["repo"] as? String, let repo = Self.repository(raw) else { return nil }
        self.repo = repo
        run = Self.integer(value["runId"]); pr = Self.integer(value["pr"])
        if let text = value["ref"] as? String, !text.isEmpty, text.utf8.count <= GitHubCIPolicy.maxIdentityChars,
           text.range(of: GitHubCIPolicy.refPattern, options: .regularExpression)?.upperBound == text.endIndex { ref = text }
        else { ref = nil }
        guard (value["runId"] == nil || run != nil), (value["pr"] == nil || pr != nil),
              run != nil || pr != nil || ref != nil else { return nil }
    }
}

struct GitHubCIEvidence: Sendable, Equatable {
    var phase = "unknown"
    var total: Int?; var passed: Int?; var failed: Int?; var pending: Int?
    var url: String?
    var reason = "unavailable"
    var retryAt: TimeInterval = 0
    func wire(into wait: [String: Any]) -> [String: Any] {
        var out = wait
        out["phase"] = phase; out["evidence"] = phase == "unknown" ? "tool_input" : "github"
        out["agentWaiting"] = phase != "passed" && phase != "failed"
        out.removeValue(forKey: "checks"); out.removeValue(forKey: "runUrl")
        if let total, let passed, let failed, let pending, phase != "unknown" {
            out["checks"] = ["total": total, "passed": passed, "failed": failed, "pending": pending]
        }
        if phase != "unknown", let url { out["runUrl"] = url }
        return out
    }
}

struct GitHubCIReply: Sendable {
    var status: Int
    var headers: [String: String]
    var body: Data
}

private final class GitHubCINoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

struct GitHubCIClient: Sendable {
    typealias Transport = @Sendable (URLRequest) async throws -> GitHubCIReply
    private let transport: Transport
    init(transport: Transport? = nil) {
        self.transport = transport ?? Self.request
    }
    private static func request(_ request: URLRequest) async throws -> GitHubCIReply {
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil; config.httpCookieStorage = nil; config.urlCredentialStorage = nil
        config.httpShouldSetCookies = false
        config.timeoutIntervalForRequest = Double(GitHubCIPolicy.requestSeconds)
        config.timeoutIntervalForResource = request.timeoutInterval
        let session = URLSession(configuration: config, delegate: GitHubCINoRedirect(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (bytes, response) = try await session.bytes(for: request)
        guard let response = response as? HTTPURLResponse else { throw Failure(reason: "invalid_response") }
        var data = Data()
        for try await byte in bytes {
            guard data.count < GitHubCIPolicy.maxBodyBytes else { throw Failure(reason: "oversize") }
            data.append(byte)
        }
        var headers: [String: String] = [:]
        for (key, value) in response.allHeaderFields { headers[String(describing: key).lowercased()] = String(describing: value) }
        return .init(status: response.statusCode, headers: headers, body: data)
    }
    struct Failure: Error {
        let reason: String
        var retryAt: TimeInterval = 0
    }
    static func validToken(_ value: String) -> Bool {
        value.hasPrefix("github_pat_") && value.utf8.count <= 4096 && value.unicodeScalars.allSatisfy {
            (65...90).contains($0.value) || (97...122).contains($0.value) || (48...57).contains($0.value) || $0.value == 95
        }
    }
    private func get(_ path: String, token: String?, deadline: Date) async throws -> [String: Any] {
        try Task.checkCancellation()
        let remaining = deadline.timeIntervalSinceNow
        guard remaining > 0 else { throw Failure(reason: "timeout") }
        var request = URLRequest(url: URL(string: "https://api.github.com/" + path)!)
        request.timeoutInterval = min(Double(GitHubCIPolicy.requestSeconds), remaining)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue(GitHubCIPolicy.apiVersion, forHTTPHeaderField: "X-GitHub-Api-Version")
        request.setValue("AgentDeck", forHTTPHeaderField: "User-Agent")
        if let token {
            guard Self.validToken(token) else { throw Failure(reason:"invalid_credential") }
            request.setValue("Bearer " + token, forHTTPHeaderField:"Authorization")
        }
        let reply = try await transport(request)
        try Task.checkCancellation()
        guard deadline.timeIntervalSinceNow > 0 else { throw Failure(reason: "timeout") }
        guard reply.body.count <= GitHubCIPolicy.maxBodyBytes else { throw Failure(reason: "oversize") }
        if reply.status == 429 || (reply.status == 403 && (reply.headers["x-ratelimit-remaining"] == "0" || reply.headers["retry-after"] != nil)) {
            let now = Date().timeIntervalSince1970
            let date = DateFormatter(); date.locale = Locale(identifier:"en_US_POSIX")
            date.timeZone = TimeZone(secondsFromGMT:0); date.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
            let retry = reply.headers["retry-after"].flatMap(Double.init).map { now + max(0, $0) }
                ?? reply.headers["retry-after"].flatMap { date.date(from:$0)?.timeIntervalSince1970 }
                ?? reply.headers["x-ratelimit-reset"].flatMap(Double.init) ?? (now + 60)
            throw Failure(reason: "rate_limited", retryAt: min(now + Double(GitHubCIPolicy.maxBackoffSeconds), max(now + 60, retry)))
        }
        guard reply.status == 200 else {
            throw Failure(reason: reply.status == 401 ? "authentication_rejected" : reply.status == 403 ? "permission_denied" : reply.status == 404 ? "not_found" : "http_error")
        }
        guard let object = try JSONSerialization.jsonObject(with: reply.body) as? [String: Any] else { throw Failure(reason: "malformed") }
        return object
    }
    func account(token: String) async throws -> (Int, String) {
        let value = try await get("user", token: token, deadline: Date().addingTimeInterval(Double(GitHubCIPolicy.probeSeconds)))
        guard let id = GitHubCIIdentity.integer(value["id"]), let login = value["login"] as? String, !login.isEmpty, login.count <= 255 else { throw Failure(reason: "invalid_account") }
        return (id, login)
    }
    static func phase(_ object: [String: Any]) -> String {
        let status = object["status"] as? String ?? ""
        if status == "in_progress" { return "running" }
        if ["queued","waiting","pending","requested"].contains(status) { return "queued" }
        guard status == "completed" else { return "unknown" }
        if object["conclusion"] as? String == "success" { return "passed" }
        return ["failure","timed_out","action_required","startup_failure"].contains(object["conclusion"] as? String ?? "") ? "failed" : "unknown"
    }
    /// A completed check run that neither validates nor blocks its commit.
    static func nonBlocking(_ object: [String: Any]) -> Bool {
        object["status"] as? String == "completed"
            && GitHubCIPolicy.nonBlockingConclusions.contains(object["conclusion"] as? String ?? "")
    }
    private static func sha(_ value: Any?) -> String? {
        guard let string = value as? String, string.count == 40, string.allSatisfy({ "0123456789abcdef".contains($0) }) else { return nil }
        return string
    }
    static func combine(_ phases: [String]) -> GitHubCIEvidence {
        guard !phases.isEmpty, !phases.contains("unknown") else { return .init(reason: "incomplete") }
        let phase = phases.contains("running") ? "running" : phases.contains("queued") ? "queued" : phases.contains("failed") ? "failed" : "passed"
        return .init(phase: phase, total: phases.count, passed: phases.filter { $0 == "passed" }.count,
            failed: phases.filter { $0 == "failed" }.count, pending: phases.filter { $0 == "running" || $0 == "queued" }.count, reason: "observed")
    }
    func probe(_ identity: GitHubCIIdentity, token: String?) async -> GitHubCIEvidence {
        let deadline = Date().addingTimeInterval(Double(GitHubCIPolicy.probeSeconds))
        let root = "repos/\(identity.repo)"
        do {
            if let run = identity.run {
                let path = "\(root)/actions/runs/\(run)"
                let first = try await get(path, token: token, deadline: deadline)
                let last = try await get(path, token: token, deadline: deadline)
                for value in [first,last] {
                    guard GitHubCIIdentity.integer(value["id"]) == run,
                          let repo = (value["repository"] as? [String: Any])?["full_name"] as? String,
                          repo.lowercased() == identity.repo, Self.sha(value["head_sha"]) != nil,
                          GitHubCIIdentity.integer(value["run_attempt"]) != nil else { throw Failure(reason: "identity_mismatch") }
                }
                guard first["head_sha"] as? String == last["head_sha"] as? String,
                      GitHubCIIdentity.integer(first["run_attempt"]) == GitHubCIIdentity.integer(last["run_attempt"]) else { throw Failure(reason: "identity_changed") }
                return .init(phase: Self.phase(last), url: "https://github.com/\(identity.repo)/actions/runs/\(run)", reason: "observed")
            }
            let encoded = identity.ref?.addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")) ?? ""
            let path = identity.pr.map { "\(root)/pulls/\($0)" } ?? "\(root)/commits/\(encoded)"
            func head(_ value: [String: Any]) throws -> String {
                if identity.pr != nil {
                    let base = value["base"] as? [String: Any]
                    guard let repo = (base?["repo"] as? [String: Any])?["full_name"] as? String,
                          repo.lowercased() == identity.repo, GitHubCIIdentity.integer(value["number"]) == identity.pr,
                          let sha = Self.sha((value["head"] as? [String: Any])?["sha"]) else { throw Failure(reason: "identity_mismatch") }
                    return sha
                }
                guard let sha = Self.sha(value["sha"]) else { throw Failure(reason: "identity_mismatch") }; return sha
            }
            let sha = try head(await get(path, token: token, deadline: deadline))
            var phases: [String] = []
            for checks in [true,false] {
                var rows: [[String: Any]] = [], total: Int?, ids = Set<String>()
                for page in 1...GitHubCIPolicy.maxPages {
                    let suffix = checks ? "check-runs" : "status"
                    let value = try await get("\(root)/commits/\(sha)/\(suffix)?per_page=\(GitHubCIPolicy.pageSize)&page=\(page)", token: token, deadline: deadline)
                    guard let count = GitHubCIIdentity.integer(value["total_count"], allowZero:true),
                          count <= GitHubCIPolicy.pageSize * GitHubCIPolicy.maxPages,
                          let batch = value[checks ? "check_runs" : "statuses"] as? [[String: Any]],
                          batch.count <= GitHubCIPolicy.pageSize,
                          total == nil || total == count else { throw Failure(reason: "incomplete") }
                    if !checks, Self.sha(value["sha"]) != sha { throw Failure(reason: "identity_mismatch") }
                    total = count
                    for row in batch {
                        let id: String
                        if checks {
                            guard Self.sha(row["head_sha"]) == sha, let n = GitHubCIIdentity.integer(row["id"]) else { throw Failure(reason: "identity_mismatch") }
                            id = String(n)
                        } else {
                            guard let context = row["context"] as? String, !context.isEmpty else { throw Failure(reason: "malformed") }; id = context
                        }
                        guard ids.insert(id).inserted else { throw Failure(reason: "incomplete") }
                    }
                    rows += batch
                    if rows.count == count { break }
                    guard !batch.isEmpty, page < GitHubCIPolicy.maxPages else { throw Failure(reason: "incomplete") }
                }
                guard rows.count == total else { throw Failure(reason: "incomplete") }
                phases += rows.filter { !(checks && Self.nonBlocking($0)) }.map { row in
                    if checks { return Self.phase(row) }
                    switch row["state"] as? String { case "success": return "passed"; case "failure", "error": return "failed"; case "pending": return "queued"; default: return "unknown" }
                }
            }
            guard try head(await get(path, token: token, deadline: deadline)) == sha else { throw Failure(reason: "head_changed") }
            var result = Self.combine(phases)
            result.url = identity.pr.map { "https://github.com/\(identity.repo)/pull/\($0)" } ?? "https://github.com/\(identity.repo)/commit/\(sha)"
            return result
        } catch let error as Failure { return .init(reason: error.reason, retryAt: error.retryAt) }
        catch { return .init(reason: Task.isCancelled ? "cancelled" : "unavailable") }
    }
}
#endif
