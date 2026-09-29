// UsageAPIClientThreadingTests.swift — concurrency regression for
// readRawCodexAuthStatus().
//
// Bug context: the Apr 13 crash (_CFRelease.cold.1 during "outlined assign
// with take of CodexAuthStatus?") stemmed from `getpwuid()` returning a
// pointer into a thread-shared buffer. Main thread + ESP32 heartbeat
// background thread both entered `codexAuthStatus` and the returned
// optional corrupted under concurrent ARC cleanup. Fix was (a) resolve
// the home directory once via `getpwuid_r`, and (b) serialize the getter
// through a DispatchQueue.
//
// This test fans out many concurrent reads; without the fix the harness
// crashes instead of failing cleanly, so "test finishes" is the pass
// condition.

#if os(macOS)
import XCTest
@testable import AgentDeck

final class UsageAPIClientThreadingTests: XCTestCase {
    func testCodexAuthStatusConcurrentReadsDoNotCrash() {
        let iterations = 500
        let client = UsageAPIClient.shared

        let expectation = self.expectation(description: "concurrent reads complete")
        expectation.expectedFulfillmentCount = iterations

        DispatchQueue.concurrentPerform(iterations: iterations) { _ in
            // The value is allowed to be nil (no Codex auth file on CI);
            // what we care about is that the call returns rather than
            // crashing in ARC cleanup.
            _ = client.codexAuthStatus
            expectation.fulfill()
        }

        wait(for: [expectation], timeout: 10)
    }

    // MARK: - Rollout tail decoding

    // A byte-offset tail read lands at an arbitrary byte, so with CJK content
    // the window routinely begins mid-character. String(data:encoding:.utf8) is
    // strict and returns nil for the WHOLE buffer, which made Codex usage vanish
    // entirely (no gauges, no error) whenever the split happened to hit a
    // multi-byte character. Node's toString('utf8') is lenient, so only the
    // Swift daemon showed it.
    func testDecodeRolloutTailRecoversFromSplitMultibyteCharacter() throws {
        let line = #"{"type":"event_msg","payload":{"rate_limits":{"primary":{"used_percent":90,"window_minutes":10080}}}}"#
        // "한글" ahead of the payload so the tail can be cut mid-character.
        var full = Data("앞선 한글 로그 줄\n".utf8)
        full.append(Data((line + "\n").utf8))

        // Cut one byte into the leading multi-byte character.
        let cut = full[1...]
        XCTAssertNil(String(data: cut, encoding: .utf8),
                     "precondition: a mid-character cut must defeat strict decoding")

        let text = try XCTUnwrap(UsageAPIClient.decodeRolloutTail(cut, seekedPastStart: true))
        let parsed = try XCTUnwrap(UsageAPIClient.parseCodexRateLimits(text),
                                   "rate limits must survive a mid-character cut")
        XCTAssertEqual(parsed.primary?.windowMinutes, 10080)
        XCTAssertEqual(parsed.primary?.usedPercent, 90)
    }

    // Reading from offset 0 is a whole-file read: there is no partial head line
    // to drop, so the first line must be preserved.
    func testDecodeRolloutTailKeepsFirstLineWhenNotSeeked() throws {
        let data = Data("{\"a\":1}\n{\"b\":2}\n".utf8)
        let text = try XCTUnwrap(UsageAPIClient.decodeRolloutTail(data, seekedPastStart: false))
        XCTAssertTrue(text.hasPrefix("{\"a\":1}"))
    }
}

private actor CodexUsageTestTransport {
    var replies: [(Data, Int)]
    var calls = 0
    init(_ replies: [(Data, Int)]) { self.replies = replies }
    func fetch(_ request: URLRequest) -> (Data, Int) {
        calls += 1
        return replies.removeFirst()
    }
}

@DaemonActor
final class CodexAccountUsageTests: XCTestCase {
    private let credential = CodexUsageCredential(accessToken: "test-only", accountId: "account-a")
    private let start = Date(timeIntervalSince1970: 1_800_000_000)
    private func payload(_ used: Int) -> Data {
        Data("""
        {"account_id":"account-a","plan_type":"pro","rate_limit":{"primary_window":{
        "used_percent":\(used),"limit_window_seconds":604800,"reset_at":1800604800},"secondary_window":null},
        "additional_rate_limits":[{"limit_name":"model pool","rate_limit":{"primary_window":{"used_percent":86}}}]}
        """.utf8)
    }

    func testCouponResetRefreshesWithoutAnyRolloutAndBeatsNewerOldSession() async {
        let transport = CodexUsageTestTransport([(payload(100), 200), (payload(0), 200)])
        let client = CodexAccountUsageClient(fetch: { await transport.fetch($0) })
        await client.refresh(credential: credential, now: start)
        XCTAssertEqual(client.snapshot(passive: nil, credential: credential, now: start)?.primary?.usedPercent, 100)
        await client.refresh(credential: credential, now: start.addingTimeInterval(29))
        let before = await transport.calls
        XCTAssertEqual(before, 1)
        await client.refresh(credential: credential, now: start.addingTimeInterval(30))
        var old = CodexAccountUsageClient.parse(payload(100), accountId: "account-a", now: start.addingTimeInterval(31))
        old?.limitId = "codex"
        let reset = client.snapshot(passive: old, credential: credential, now: start.addingTimeInterval(31))
        XCTAssertEqual(reset?.primary?.usedPercent, 0)
        XCTAssertNil(reset?.secondary)
    }

    func testFailureRetainsOriginalTimestampAndBacksOff() async {
        let transport = CodexUsageTestTransport([(payload(100), 200), (Data(), 503)])
        let client = CodexAccountUsageClient(fetch: { await transport.fetch($0) })
        await client.refresh(credential: credential, now: start)
        let stamp = client.snapshot(passive: nil, credential: credential, now: start)?.capturedAt
        await client.refresh(credential: credential, now: start.addingTimeInterval(30))
        await client.refresh(credential: credential, now: start.addingTimeInterval(60))
        let calls = await transport.calls
        XCTAssertEqual(calls, 2)
        let retained = client.snapshot(passive: nil, credential: credential, now: start.addingTimeInterval(60))
        XCTAssertEqual(retained?.primary?.usedPercent, 100)
        XCTAssertEqual(retained?.capturedAt, stamp)
    }

    func testCredentialRemovalAndAccountChangeDoNotReuseSnapshot() async {
        let transport = CodexUsageTestTransport([(payload(100), 200)])
        let client = CodexAccountUsageClient(fetch: { await transport.fetch($0) })
        await client.refresh(credential: credential, now: start)
        let other = CodexUsageCredential(accessToken: "other-test", accountId: "account-b")
        XCTAssertNil(client.snapshot(passive: nil, credential: other, now: start))
        await client.refresh(credential: nil, now: start)
        XCTAssertNil(client.snapshot(passive: nil, credential: credential, now: start))
    }

    func testMalformedAndWrongAccountResponsesAreNotZero() async {
        XCTAssertNil(CodexAccountUsageClient.parse(payload(0), accountId: "account-b", now: start))
        XCTAssertNil(CodexAccountUsageClient.parse(Data("{}".utf8), accountId: "account-a", now: start))
        let malformed = Data("""
        {"plan_type":"pro","rate_limit":{"primary_window":{"used_percent":0}},
        "credits":{"has_credits":false,"unlimited":false,"balance":"0"}}
        """.utf8)
        XCTAssertNil(CodexAccountUsageClient.parse(malformed, accountId: "account-a", now: start))
    }
}

#endif
