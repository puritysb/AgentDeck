#if os(macOS)
import XCTest
@testable import AgentDeck

private actor StorageReplies {
    struct Reply: Sendable { let path: String; let status: Int; let data: Data }
    var replies: [Reply]
    var requests: [URLRequest] = []
    init(_ replies: [Reply]) { self.replies = replies }
    func send(_ request: URLRequest) throws -> (Data, URLResponse) {
        requests.append(request)
        XCTAssertEqual(request.url?.host, "127.0.0.1")
        XCTAssertEqual(request.timeoutInterval, 40)
        XCTAssertEqual(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "token" })?.value, "fixture-token")
        let next = replies.removeFirst()
        XCTAssertEqual(request.url?.path, next.path)
        if next.status == 0 { throw URLError(.timedOut) }
        return (next.data, HTTPURLResponse(url: request.url!, statusCode: next.status, httpVersion: nil, headerFields: nil)!)
    }
}

@MainActor
final class ApmeStorageModelTests: XCTestCase {
    private func preview() throws -> Data {
        try JSONEncoder().encode(ApmePrunePreview(cutoffMs: 1000, fingerprint: String(repeating: "a", count: 64),
                                                steps: ApmePruneEstimate(rows: 2, bytesBefore: 10), sampleEvents: ApmePruneEstimate(rows: 1, bytesBefore: 20)))
    }
    func testPreviewNeverAppliesAutomaticallyDaysChangeInvalidatesAndStaleApplyClearsPreview() async throws {
        let script = StorageReplies([
            .init(path: "/apme/storage/preview", status: 200, data: try preview()),
            .init(path: "/apme/storage/preview", status: 200, data: try preview()),
            .init(path: "/apme/storage/prune", status: 409, data: Data(#"{"error":"Preview changed"}"#.utf8)),
        ])
        let model = ApmeStorageModel(endpoint: URL(string: "http://127.0.0.1:19480")!, token: "fixture-token", transport: { try await script.send($0) })
        await model.makePreview()
        XCTAssertNotNil(model.preview); XCTAssertFalse(model.busy)
        let first = await script.requests
        XCTAssertEqual(first.count, 1); XCTAssertEqual(first[0].httpMethod, "GET")
        model.days = 60; XCTAssertNil(model.preview)
        await model.apply()
        let untouched = await script.requests; XCTAssertEqual(untouched.count, 1)
        await model.makePreview(); await model.apply()
        XCTAssertNil(model.preview); XCTAssertFalse(model.busy)
        XCTAssertEqual(model.message, "Preview changed")
        let requests = await script.requests
        let sent = try XCTUnwrap(requests.last?.httpBody)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: sent) as? [String: Any])
        XCTAssertEqual(object["confirm"] as? Bool, true)
        XCTAssertEqual(object["cutoffMs"] as? Int, 1000)
        XCTAssertEqual(object["fingerprint"] as? String, String(repeating: "a", count: 64))
    }
    func testTimeoutEndsBusyAndSuccessfulCleanupSurvivesSizeRefreshFailure() async throws {
        let script = StorageReplies([
            .init(path: "/apme/storage", status: 0, data: Data()),
            .init(path: "/apme/storage/preview", status: 200, data: try preview()),
            .init(path: "/apme/storage/prune", status: 200, data: try preview()),
            .init(path: "/apme/storage", status: 503, data: Data()),
        ])
        let model = ApmeStorageModel(endpoint: URL(string: "http://127.0.0.1:19480")!, token: "fixture-token", transport: { try await script.send($0) })
        await model.refresh(); XCTAssertFalse(model.busy); XCTAssertNil(model.status); XCTAssertNotNil(model.message)
        await model.makePreview(); await model.apply()
        XCTAssertNil(model.preview); XCTAssertFalse(model.busy); XCTAssertNil(model.status)
        XCTAssertEqual(model.message, "Cleanup finished; current file sizes could not be refreshed.")
    }
}
#endif
