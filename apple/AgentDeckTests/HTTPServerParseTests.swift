// HTTPServerParseTests.swift — request-line parsing contracts.
//
// Regression gate for query-string form-decoding: the Work-board search box
// sends URLSearchParams output (`q=fix+bug`, percent-escaped Korean), which
// Node's url.searchParams decodes before the SQL LIKE. The Swift daemon's
// parseHTTPRequest stored the raw bytes, so the identical dashboard search
// silently matched nothing whenever this daemon owned the port.

#if os(macOS)
import XCTest
@testable import AgentDeck

final class HTTPServerParseTests: XCTestCase {

    private func parse(_ target: String) -> HTTPServer.HTTPRequest {
        let raw = Data("GET \(target) HTTP/1.1\r\nHost: x\r\n\r\n".utf8)
        return HTTPServer.parseHTTPRequest(raw, remoteIP: "127.0.0.1")
    }

    func testQueryParamsFormDecodePlusAndPercent() {
        let req = parse("/apme/tasks?q=fix+bug&project=my%20proj&limit=50")
        XCTAssertEqual(req.path, "/apme/tasks")
        XCTAssertEqual(req.queryParams["q"], "fix bug")
        XCTAssertEqual(req.queryParams["project"], "my proj")
        XCTAssertEqual(req.queryParams["limit"], "50")
    }

    func testQueryParamsDecodeKorean() {
        // URLSearchParams('q=작업 정리') → q=%EC%9E%91%EC%97%85+%EC%A0%95%EB%A6%AC
        let req = parse("/apme/tasks?q=%EC%9E%91%EC%97%85+%EC%A0%95%EB%A6%AC")
        XCTAssertEqual(req.queryParams["q"], "작업 정리")
    }

    func testMalformedEscapeKeepsRawValue() {
        // A broken escape must not drop the parameter — keep the raw string.
        let req = parse("/x?bad=100%zz")
        XCTAssertEqual(req.queryParams["bad"], "100%zz")
    }

    func testPlainTokenValueUnchanged() {
        // Hex pairing tokens carry no '+' or '%' — decoding is a no-op.
        let req = parse("/apme/runs?token=abc123DEF")
        XCTAssertEqual(req.queryParams["token"], "abc123DEF")
    }

    // MARK: - Only the head is text

    func testABodyThatIsNotUTF8StillReachesItsRoute() {
        // A protobuf OTLP batch, as Codex sends one when it ignores the
        // configured JSON protocol. Decoding the whole request read it as
        // `GET /` with no headers, so the route's 415 was never sent.
        let payload = Data([0x0A, 0xFF, 0xFE, 0x00, 0x01, 0x0D, 0x0A, 0x0D, 0x0A, 0x80])
        var raw = Data(("POST /otel/v1/traces HTTP/1.1\r\nHost: 127.0.0.1:9120\r\n"
            + "Content-Type: application/x-protobuf\r\nContent-Length: \(payload.count)\r\n\r\n").utf8)
        raw.append(payload)
        let req = HTTPServer.parseHTTPRequest(raw, remoteIP: "127.0.0.1")
        XCTAssertEqual(req.method, "POST")
        XCTAssertEqual(req.path, "/otel/v1/traces")
        XCTAssertEqual(req.headers["content-type"], "application/x-protobuf")
        XCTAssertEqual(req.headers.count, 3, "a blank line inside the body adds no header")
        XCTAssertEqual(req.body, payload)
    }

    func testAHeadThatIsNotUTF8IsReadAsLatin1() {
        // Node reads header values byte for byte (latin1); this head used to
        // become `GET /` with every header dropped.
        var raw = Data("PUT /h HTTP/1.1\r\nHost: 127.0.0.1:9120\r\nX-A: v".utf8)
        raw.append(0xFF)
        raw.append(Data("\r\n\r\n".utf8))
        let req = HTTPServer.parseHTTPRequest(raw, remoteIP: "127.0.0.1")
        XCTAssertEqual(req.method, "PUT")
        XCTAssertEqual(req.path, "/h")
        XCTAssertEqual(req.headers["host"], "127.0.0.1:9120")
        XCTAssertEqual(req.headers["x-a"], "v\u{FF}")
        XCTAssertNil(req.body)
    }

    func testAUTF8HeadIsStillReadAsUTF8() {
        let req = HTTPServer.parseHTTPRequest(
            Data("GET /h HTTP/1.1\r\nHost: x\r\nX-A: 작업\r\n\r\n".utf8), remoteIP: "127.0.0.1")
        XCTAssertEqual(req.headers["x-a"], "작업")
    }
}
#endif
