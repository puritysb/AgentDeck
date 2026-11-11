#if os(macOS)
import XCTest
@testable import AgentDeck

private func ciReply(_ value: [String: Any], status: Int = 200, headers: [String: String] = [:]) throws -> GitHubCIReply {
    guard JSONSerialization.isValidJSONObject(value) else { throw URLError(.cannotParseResponse) }
    return .init(status:status,headers:headers,body:try JSONSerialization.data(withJSONObject:value))
}
private let ciSHA = String(repeating:"a",count:40)
private func ciRun(_ id: Int = 7, attempt: Int = 1, repo: String = "owner/repo") -> [String: Any] {
    ["id":id,"repository":["full_name":repo],"head_sha":ciSHA,"run_attempt":attempt,"status":"completed","conclusion":"success"]
}
private actor CIRequests {
    var paths: [String] = []
    let reply: @Sendable (URLRequest, Int) throws -> GitHubCIReply
    init(_ reply: @escaping @Sendable (URLRequest, Int) throws -> GitHubCIReply) { self.reply = reply }
    func request(_ r: URLRequest) throws -> GitHubCIReply {
        paths.append(r.url!.absoluteString)
        XCTAssertEqual(r.url?.host,"api.github.com")
        XCTAssertEqual(r.httpMethod,"GET")
        XCTAssertLessThanOrEqual(r.timeoutInterval,8)
        XCTAssertFalse(r.url!.absoluteString.contains("github_pat"))
        return try reply(r,paths.count)
    }
}
private final class CIMemory: @unchecked Sendable {
    let lock = NSLock()
    var data: Data?; var enabled = false; var removeFails = false
    func storage() -> GitHubCIStorage {
        .init(load:{ self.lock.withLock { self.data } },save:{ value in self.lock.withLock { self.data = value } },remove:{
            try self.lock.withLock { if self.removeFails { throw URLError(.noPermissionsToReadFile) }; self.data = nil }
        },consent:{ self.lock.withLock { self.enabled } },setConsent:{ value in self.lock.withLock { self.enabled = value } })
    }
}
private actor CIDeferred {
    var started = false
    var continuation: CheckedContinuation<GitHubCIReply, Never>?
    func request(_ r: URLRequest) async -> GitHubCIReply {
        started = true
        return await withCheckedContinuation { continuation = $0 }
    }
    func release(_ reply: GitHubCIReply) { continuation?.resume(returning:reply); continuation = nil }
}

final class GitHubCIProviderTests: XCTestCase {
    func testRunIdentityAndRerunAttemptAreChecked() async throws {
        let identity = try XCTUnwrap(GitHubCIIdentity(["repo":"Owner/Repo","runId":7]))
        for mismatch in ["none","repo","attempt","id"] {
            let stub = CIRequests { _, count in
                try ciReply(ciRun(mismatch == "id" ? 8 : 7, attempt:mismatch == "attempt" && count == 2 ? 2 : 1,
                                  repo:mismatch == "repo" ? "other/repo" : "owner/repo"))
            }
            let result = await GitHubCIClient(transport:{ request in try await stub.request(request) }).probe(identity,token:"github_pat_fixture")
            XCTAssertEqual(result.phase,mismatch == "none" ? "passed" : "unknown")
        }
        XCTAssertNil(GitHubCIIdentity(["repo":"../repo","runId":7]))
        XCTAssertNil(GitHubCIIdentity(["repo":"owner/repo","runId":true]))
        XCTAssertNil(GitHubCIIdentity(["repo":"owner/repo","runId":9_007_199_254_740_992]))
    }
    func testCommitReadsCompleteChecksAndStatusesAndRechecksHead() async throws {
        let identity = try XCTUnwrap(GitHubCIIdentity(["repo":"owner/repo","ref":"feature/topic"]))
        for moved in [false,true] {
            let stub = CIRequests { r, n in
                if r.url!.path.hasSuffix("check-runs") { return try ciReply(["total_count":1,"check_runs":[["id":1,"head_sha":ciSHA,"status":"completed","conclusion":"success"]]]) }
                if r.url!.path.hasSuffix("status") { return try ciReply(["sha":ciSHA,"total_count":1,"statuses":[["context":"legacy","state":"failure"]]]) }
                XCTAssertTrue(r.url!.absoluteString.contains("feature%2Ftopic"))
                return try ciReply(["sha":moved && n > 1 ? String(repeating:"b",count:40) : ciSHA])
            }
            let result = await GitHubCIClient(transport:{ request in try await stub.request(request) }).probe(identity,token:nil)
            XCTAssertEqual(result.phase,moved ? "unknown" : "failed")
            XCTAssertEqual(result.total,moved ? nil : 2)
            if moved { XCTAssertNil(result.wire(into:[:])["checks"]) }
        }
    }
    func testPRBaseRepositoryAndNumberMustMatch() async throws {
        let identity = try XCTUnwrap(GitHubCIIdentity(["repo":"owner/repo","pr":42]))
        let stub = CIRequests { _,_ in try ciReply(["number":43,"head":["sha":ciSHA],"base":["repo":["full_name":"owner/repo"]]]) }
        let value = await GitHubCIClient(transport:{ request in try await stub.request(request) }).probe(identity,token:nil)
        XCTAssertEqual(value.reason,"identity_mismatch")
        XCTAssertEqual(value.phase,"unknown")
    }
    func testPaginationOverOnePageIsCompleteAndDuplicatePagesFailClosed() async throws {
        let identity = try XCTUnwrap(GitHubCIIdentity(["repo":"owner/repo","ref":"main"]))
        for duplicate in [false,true] {
            let stub = CIRequests { r,_ in
                if r.url!.path.hasSuffix("check-runs") {
                    let second = r.url!.query!.contains("page=2")
                    let ids = second ? [duplicate ? 1 : 101] : Array(1...100)
                    return try ciReply(["total_count":101,"check_runs":ids.map { ["id":$0,"head_sha":ciSHA,"status":"completed","conclusion":"success"] as [String:Any] }])
                }
                if r.url!.path.hasSuffix("status") { return try ciReply(["sha":ciSHA,"total_count":0,"statuses":[]]) }
                return try ciReply(["sha":ciSHA])
            }
            let value = await GitHubCIClient(transport:{ request in try await stub.request(request) }).probe(identity,token:nil)
            XCTAssertEqual(value.phase,duplicate ? "unknown" : "passed")
            XCTAssertEqual(value.total,duplicate ? nil : 101)
        }
    }
    func testEmptyIncompleteMalformedCancelledAndNeutralNeverProveSuccess() async throws {
        XCTAssertEqual(GitHubCIClient.combine([]).phase,"unknown")
        for conclusion in ["cancelled","skipped","neutral","stale",""] {
            XCTAssertEqual(GitHubCIClient.phase(["status":"completed","conclusion":conclusion]),"unknown")
        }
        let identity = try XCTUnwrap(GitHubCIIdentity(["repo":"owner/repo","ref":"main"]))
        for count in [0,2] {
            let stub = CIRequests { r,_ in
                if r.url!.path.hasSuffix("check-runs") { return try ciReply(["total_count":count,"check_runs":[]]) }
                if r.url!.path.hasSuffix("status") { return try ciReply(["sha":ciSHA,"total_count":0,"statuses":[]]) }
                return try ciReply(["sha":ciSHA])
            }
            let value = await GitHubCIClient(transport:{ request in try await stub.request(request) }).probe(identity,token:nil)
            XCTAssertEqual(value.phase,"unknown"); XCTAssertNil(value.total)
        }
    }
    /// Measured on a real pull request: two skipped compile jobs and a neutral
    /// CodeQL run kept every watched PR unread while other checks ran or passed.
    func testSkippedAndNeutralChecksAreLeftOutOfTheCommitVerdict() async throws {
        let identity = try XCTUnwrap(GitHubCIIdentity(["repo":"owner/repo","ref":"main"]))
        func probe(_ runs: [(String, String?)]) async throws -> GitHubCIEvidence {
            let rows: [[String: Any]] = runs.enumerated().map { index, run in
                ["id":index+1,"head_sha":ciSHA,"status":run.0,"conclusion":run.1 as Any? ?? NSNull()]
            }
            let checks = try JSONSerialization.data(withJSONObject:["total_count":rows.count,"check_runs":rows])
            let stub = CIRequests { r,_ in
                if r.url!.path.hasSuffix("check-runs") { return .init(status:200,headers:[:],body:checks) }
                if r.url!.path.hasSuffix("status") { return try ciReply(["sha":ciSHA,"total_count":0,"statuses":[]]) }
                return try ciReply(["sha":ciSHA])
            }
            return await GitHubCIClient(transport:{ request in try await stub.request(request) }).probe(identity,token:nil)
        }
        let running = try await probe([("completed","success"),("completed","skipped"),("completed","neutral"),("in_progress",nil)])
        XCTAssertEqual(running.phase,"running"); XCTAssertEqual(running.total,2); XCTAssertEqual(running.passed,1)
        let settled = try await probe([("completed","success"),("completed","skipped"),("completed","neutral")])
        XCTAssertEqual(settled.phase,"passed"); XCTAssertEqual(settled.total,1)
        let onlySkipped = try await probe([("completed","skipped"),("completed","neutral")])
        XCTAssertEqual(onlySkipped.phase,"unknown"); XCTAssertNil(onlySkipped.total)
        let cancelled = try await probe([("completed","success"),("completed","cancelled")])
        XCTAssertEqual(cancelled.phase,"unknown")
    }
    func testHTTPAuthPermissionsRateLimitAndOversizeBecomeUnknown() async throws {
        for token in ["ghp_classic", "github_pat_a\0b", "github_pat_a\nb", "github_pat_é"] {
            XCTAssertFalse(GitHubCIClient.validToken(token))
        }
        XCTAssertTrue(GitHubCIClient.validToken("github_pat_fixture"))
        let identity = try XCTUnwrap(GitHubCIIdentity(["repo":"owner/repo","runId":7]))
        for status in [401,403,404,429,302,500] {
            let stub = CIRequests { _,_ in try ciReply([:],status:status,headers:status == 429 ? ["retry-after":"120"] : [:]) }
            let value = await GitHubCIClient(transport:{ request in try await stub.request(request) }).probe(identity,token:"github_pat_fixture")
            XCTAssertEqual(value.phase,"unknown"); XCTAssertNil(value.total)
            if status == 401 { XCTAssertEqual(value.reason,"authentication_rejected") }
            if status == 403 { XCTAssertEqual(value.reason,"permission_denied") }
            if status == 429 { XCTAssertGreaterThan(value.retryAt,Date().timeIntervalSince1970 + 90) }
        }
        let tooLarge = GitHubCIClient { _ in .init(status:200,headers:[:],body:Data(repeating:32,count:GitHubCIPolicy.maxBodyBytes+1)) }
        let oversized = await tooLarge.probe(identity,token:nil); XCTAssertEqual(oversized.reason,"oversize")
        let timeout = GitHubCIClient { _ in throw URLError(.timedOut) }
        let unknown = await timeout.probe(identity,token:nil); XCTAssertEqual(unknown.phase,"unknown")
    }
    func testConsentAccountKeychainPayloadRelaunchAndFailedRemovalRemainDisabled() async throws {
        let memory = CIMemory()
        let stub = CIRequests { r,_ in
            XCTAssertEqual(r.value(forHTTPHeaderField:"Authorization"),"Bearer github_pat_fixture")
            return try ciReply(["id":19,"login":"reviewer"])
        }
        let connection = GitHubCIConnection(storage:memory.storage(),client:.init(transport:{ request in try await stub.request(request) }))
        do { try await connection.connect(repositories:["owner/repo"],token:"github_pat_fixture",consent:false); XCTFail("consent bypass") } catch {}
        XCTAssertNil(memory.data)
        try await connection.connect(repositories:["Owner/Repo"],token:"github_pat_fixture",consent:true)
        XCTAssertTrue(memory.enabled)
        let restored = GitHubCIConnection(storage:memory.storage())
        let loaded = try await restored.snapshot()
        XCTAssertEqual(loaded.account?.id,19); XCTAssertEqual(loaded.account?.repositories,["owner/repo"])
        XCTAssertEqual(loaded.account?.token,"github_pat_fixture")
        memory.removeFails = true
        do { try await connection.disconnect(); XCTFail("removal error ignored") } catch {}
        XCTAssertFalse(memory.enabled)
        let next = GitHubCIConnection(storage:memory.storage())
        let disabled = try await next.snapshot(); XCTAssertNil(disabled.account)
    }
    func testDisconnectDuringAccountValidationCannotResurrectCredentials() async throws {
        let memory = CIMemory(), gate = CIDeferred()
        let connection = GitHubCIConnection(storage:memory.storage(),client:.init(transport:{ request in await gate.request(request) }))
        let task = Task { try await connection.connect(repositories:["owner/repo"],token:"github_pat_fixture",consent:true) }
        for _ in 0..<100 { if await gate.started { break }; try await Task.sleep(for:.milliseconds(1)) }
        try await connection.disconnect()
        await gate.release(try ciReply(["id":7,"login":"old"]))
        do { try await task.value; XCTFail("late save") } catch {}
        XCTAssertNil(memory.data); XCTAssertFalse(memory.enabled)
    }
    @DaemonActor
    func testProjectionFreshnessAccountSwitchAndTerminalExpiry() async throws {
        let memory = CIMemory()
        let account = GitHubCIConnection(storage:memory.storage())
        try await account.connect(repositories:["owner/repo"],token:nil,consent:true)
        let provider = GitHubCIProvider(connection:account,client:GitHubCIClient { _ in try ciReply(ciRun()) })
        await provider.syncConfiguration()
        let now = Date().timeIntervalSince1970
        let wait: [String:Any] = ["repo":"owner/repo","runId":7,"openedAt":10,"phase":"unknown","agentWaiting":true]
        _ = provider.poll([("s",1,wait)],now:now,changed:{})
        for _ in 0..<100 {
            if provider.projection(wait,sid:"s",token:1,now:Date().timeIntervalSince1970)["phase"] as? String == "passed" { break }
            try await Task.sleep(for:.milliseconds(1))
        }
        XCTAssertEqual(provider.projection(wait,sid:"s",token:1,now:Date().timeIntervalSince1970)["phase"] as? String,"passed")
        XCTAssertEqual(provider.projection(wait,sid:"s",token:2,now:now+1)["phase"] as? String,"unknown")
        XCTAssertEqual(provider.projection(wait,sid:"s",token:1,now:now+100)["phase"] as? String,"unknown")
        let closed = provider.poll([("s",1,wait)],now:now+31,changed:{})
        XCTAssertEqual(closed.first?.0,"s")
        try await account.disconnect()
        XCTAssertEqual(provider.projection(wait,sid:"s",token:1,now:now+1)["phase"] as? String,"unknown")
        provider.stop()
    }
    @DaemonActor
    func testLateResponseAfterDisconnectOrStopNeverPublishes() async throws {
        for stop in [false,true] {
            let account = GitHubCIConnection(storage:CIMemory().storage())
            try await account.connect(repositories:["owner/repo"],token:nil,consent:true)
            let gate = CIDeferred(), provider = GitHubCIProvider(connection:account,client:.init(transport:{ request in await gate.request(request) }))
            await provider.syncConfiguration()
            let wait: [String:Any] = ["repo":"owner/repo","runId":7,"openedAt":10]
            _ = provider.poll([("s",1,wait)],now:Date().timeIntervalSince1970,changed:{})
            for _ in 0..<100 { if await gate.started { break }; try await Task.sleep(for:.milliseconds(1)) }
            if stop { provider.stop() } else { try await account.disconnect() }
            await gate.release(try ciReply(ciRun()))
            try await Task.sleep(for:.milliseconds(10))
            XCTAssertEqual(provider.projection(wait,sid:"s",token:1,now:Date().timeIntervalSince1970)["phase"] as? String,"unknown")
            provider.stop()
        }
    }
    @DaemonActor
    func testRateLimitBackoffAppliesToAllWaitsAndConcurrencyIsBounded() async throws {
        let account = GitHubCIConnection(storage:CIMemory().storage())
        try await account.connect(repositories:["owner/repo"],token:nil,consent:true)
        let stub = CIRequests { _,_ in try ciReply([:],status:429,headers:["retry-after":"120"]) }
        let provider = GitHubCIProvider(connection:account,client:.init(transport:{ request in try await stub.request(request) }))
        await provider.syncConfiguration()
        let waits = (1...8).map { ("s\($0)", $0, ["repo":"owner/repo","runId":$0,"openedAt":10] as [String:Any]) }
        let now = Date().timeIntervalSince1970
        _ = provider.poll(waits,now:now,changed:{})
        try await Task.sleep(for:.milliseconds(30))
        let before = await stub.paths.count
        XCTAssertEqual(before,4)
        _ = provider.poll(waits,now:now+5,changed:{})
        try await Task.sleep(for:.milliseconds(10))
        let after = await stub.paths.count
        XCTAssertEqual(after,before)
        provider.stop()
    }
    func testOwnKeychainRoundTripWhenTestHostIsEntitled() throws {
        let storage = GitHubCIStorage.keychain(service:"bound.serendipity.agent.deck.tests.github-ci." + UUID().uuidString)
        let data = Data("synthetic-keychain-test".utf8)
        do { try storage.save(data) }
        catch let error as NSError where error.code == Int(errSecMissingEntitlement) || error.code == Int(errSecNotAvailable) {
            throw XCTSkip("Unsigned test host cannot access the app Data Protection Keychain; signed-app acceptance is separate.")
        }
        defer { try? storage.remove() }
        XCTAssertEqual(try storage.load(),data)
        try storage.remove(); XCTAssertNil(try storage.load())
    }

}
#endif
