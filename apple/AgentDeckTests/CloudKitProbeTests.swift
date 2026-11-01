#if AGENTDECK_CLOUDKIT_POC
import XCTest
@testable import AgentDeck

final class CloudKitProbeTests: XCTestCase {
    func testSilentPeerTerminatesWithTimeout() async {
        let store = CloudKitProbeStore()
        do {
            let _: Bool = try await store.bounded(timeout: .milliseconds(10)) { _ in }
            XCTFail("A silent peer must not leave the operation busy forever")
        } catch {
            XCTAssertEqual((error as? URLError)?.code, .timedOut)
        }
    }

    func testDuplicateAndLateCompletionCannotResumeTwice() async throws {
        let store = CloudKitProbeStore()
        let value: Bool = try await store.bounded(timeout: .milliseconds(10)) { done in
            done.finish(.success(true))
            done.finish(.failure(URLError(.cancelled)))
        }
        XCTAssertTrue(value)
        try await Task.sleep(for: .milliseconds(30))
    }
}
#endif
