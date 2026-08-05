import XCTest
@testable import AgentDeck

/// Parity gate for what a spoken reply says.
///
/// `spokenDigest` is a hand mirror of the TypeScript SSOT in
/// `shared/src/voice-reply-digest.ts`, and the cases below are that file's
/// exported `SPOKEN_DIGEST_CASES` verbatim. If the two daemons speak different
/// amounts of the same reply, the same VOICE key behaves differently depending
/// on which daemon happens to be serving — so a case added on either side has
/// to be added on the other.
final class SpokenDigestParityTests: XCTestCase {

    /// Mirror of SPOKEN_DIGEST_CASES in shared/src/voice-reply-digest.ts.
    private let cases: [(name: String, input: String, expected: String)] = [
        (
            "first sentence only, not the whole paragraph",
            "원인을 찾았습니다. 헬퍼 바이너리에 Info.plist가 없었습니다. 지금은 고쳤습니다.",
            "원인을 찾았습니다."
        ),
        (
            "explicit summary label wins over the opening sentence",
            "VOICE 키가 죽어 있었습니다. 원인은 TCC입니다.\n요약: 헬퍼를 재빌드하면 동작합니다.",
            "헬퍼를 재빌드하면 동작합니다."
        ),
        (
            "bare summary label takes the line after it",
            "TL;DR\nThe helper needed a usage description.\nDetails follow.",
            "The helper needed a usage description."
        ),
        (
            "a heading-only first line is skipped for the prose under it",
            "## 원인\n번들 헬퍼에 Info.plist가 없었습니다. 그래서 TCC가 죽였습니다.",
            "번들 헬퍼에 Info.plist가 없었습니다."
        ),
        (
            "code fences never get recited",
            "Fixed it.\n\n```ts\nconst x = 1;\n```\n",
            "Fixed it."
        ),
        (
            "a version number does not end the sentence",
            "Bumped it to 1.0.2 for the release. Nothing else changed.",
            "Bumped it to 1.0.2 for the release."
        ),
        (
            "nothing speakable stays empty",
            "```\ndiff --git a b\n```",
            "(code)"
        ),
    ]

    func testMatchesSharedParityCases() {
        for c in cases {
            XCTAssertEqual(
                DaemonServer.spokenDigest(c.input), c.expected,
                "parity case drifted: \(c.name)")
        }
    }

    func testReadsOneSentenceOutOfALongAnswer() {
        let body = "고쳤습니다. " + String(repeating: "이유는 여러 가지입니다. ", count: 40)
        let out = DaemonServer.spokenDigest(body)

        XCTAssertEqual(out, "고쳤습니다.")
        XCTAssertLessThan(out.count, DaemonServer.spokenDigestMaxChars)
    }

    func testProseOpeningWithALabelWordIsNotASummary() {
        // "요약" is the sentence's subject here, not a heading.
        XCTAssertEqual(
            DaemonServer.spokenDigest("요약 문서는 따로 없습니다. 코드를 보세요."),
            "요약 문서는 따로 없습니다.")
    }

    func testOverLongSentenceCutsOnAWordBoundary() {
        let sentence = String(repeating: "word ", count: 120)
            .trimmingCharacters(in: .whitespaces) + " end"
        let out = DaemonServer.spokenDigest(sentence)

        XCTAssertLessThanOrEqual(out.count, DaemonServer.spokenDigestMaxChars)
        XCTAssertTrue(out.hasSuffix("word"), "cut mid-word: \(out.suffix(20))")
    }

    func testFullOptsBackIntoTheWholeReadableAnswer() {
        let body = "First. Second. Third."

        XCTAssertEqual(DaemonServer.spokenDigest(body, full: true), body)
        XCTAssertEqual(DaemonServer.spokenDigest(body), "First.")
    }

    func testEmptyStaysEmpty() {
        XCTAssertEqual(DaemonServer.spokenDigest(""), "")
        XCTAssertEqual(DaemonServer.spokenDigest("   \n \n"), "")
    }
}
