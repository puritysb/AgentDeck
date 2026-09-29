#if os(macOS)
import XCTest
@testable import AgentDeck

final class MlxSafetyTests: XCTestCase {
    func testSharedModelSelectionVectors() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let rows = try JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("shared/mlx-safety-vectors.json"))) as! [[String: Any]]
        for row in rows {
            let run = { try MlxSafetyRules.select(loadedKnown: row["known"] as! Bool, loaded: row["loaded"] as? String,
                catalog: row["catalog"] as! [String], requested: row["pin"] as? String) }
            if let expected = row["expected"] as? String { XCTAssertEqual(try run(), expected, row["name"] as! String) }
            else { XCTAssertThrowsError(try run(), row["name"] as! String) }
        }
    }

    func testMismatchCannotPostEvenWithExplicitPin() async throws {
        let stub = ServerStub()
        let client = MlxInference(transport: { try await stub.request($0) })
        do { _ = try await client.send(request(model: "qwen")); XCTFail("must reject") } catch {}
        let posts = await stub.posts
        XCTAssertEqual(posts, 0)
    }

    func testServerFailureQuarantinesFollowingRequests() async throws {
        let stub = ServerStub(status: 500)
        let client = MlxInference(transport: { try await stub.request($0) })
        _ = try await client.send(request(model: "gemma"))
        do { _ = try await client.send(request(model: "gemma")); XCTFail("must quarantine") } catch {}
        let posts = await stub.posts
        XCTAssertEqual(posts, 1)
    }

    func testTransportTimeoutQuarantinesEndpoint() async throws {
        let stub = ServerStub(timeout: true)
        let client = MlxInference(transport: { try await stub.request($0) })
        do { _ = try await client.send(request(model: "gemma")); XCTFail("must time out") } catch {}
        do { _ = try await client.send(request(model: "gemma")); XCTFail("must quarantine") } catch {}
        let posts = await stub.posts
        XCTAssertEqual(posts, 1)
    }

    func testActorReentrancyCannotAdmitConcurrentInference() async throws {
        let stub = SuspendedServer()
        let client = MlxInference(transport: { try await stub.request($0) })
        let original = request(model: "gemma")
        let first = Task { try await client.send(original) }
        await stub.waitForPost()
        do { _ = try await client.send(original); XCTFail("must refuse second admission") } catch {}
        await stub.release()
        _ = try await first.value
        let posts = await stub.posts
        XCTAssertEqual(posts, 1)
    }

    func testOomMetricsOverrideHealthyAndRecoverOnlyAfterSuccess() {
        let error: [String: Any] = ["timestamp_unix": 2, "error": "Insufficient Memory"]
        XCTAssertNotNil(MlxSafetyRules.metricsProblem(["summary": ["last_error": error], "latest": ["timestamp_unix": 1]]))
        XCTAssertNil(MlxSafetyRules.metricsProblem(["summary": ["last_error": error], "latest": ["timestamp_unix": 3]]))
        XCTAssertNotNil(MlxSafetyRules.metricsProblem(["summary": ["in_flight": 1]]))
    }

    private func request(model: String) -> URLRequest {
        var request = URLRequest(url: URL(string: "http://localhost:18800/v1/chat/completions")!)
        request.httpMethod = "POST"
        request.httpBody = try! JSONSerialization.data(withJSONObject: ["model": model, "max_tokens": 1])
        return request
    }
}

private actor ServerStub {
    var posts = 0
    let status: Int
    let timeout: Bool
    init(status: Int = 200, timeout: Bool = false) { self.status = status; self.timeout = timeout }
    func request(_ request: URLRequest) throws -> (Data, URLResponse) {
        let url = request.url!
        var code = 200
        let value: [String: Any]
        if request.httpMethod == "POST" {
            posts += 1
            if timeout { throw URLError(.timedOut) }
            code = status; value = ["choices": []]
        }
        else if url.path.hasSuffix("/health") { value = ["loaded_model": "gemma"] }
        else { value = ["summary": ["in_flight": 0]] }
        return (try JSONSerialization.data(withJSONObject: value), HTTPURLResponse(url: url, statusCode: code, httpVersion: nil, headerFields: nil)!)
    }
}
private actor SuspendedServer {
    var posts = 0
    private var continuation: CheckedContinuation<Void, Never>?
    func waitForPost() async { while posts == 0 { await Task.yield() } }
    func release() { continuation?.resume(); continuation = nil }
    func request(_ request: URLRequest) async throws -> (Data, URLResponse) {
        if request.httpMethod == "POST" {
            posts += 1
            await withCheckedContinuation { continuation = $0 }
        }
        let body: [String: Any] = request.url!.path.hasSuffix("/health") ? ["loaded_model": "gemma"] : [:]
        return (try JSONSerialization.data(withJSONObject: body), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}
#endif
