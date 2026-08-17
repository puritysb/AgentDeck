#if os(macOS)
// Kiro transcript parsing for the in-process daemon.
//
// The fixtures are TRANSCRIBED from a real Kiro CLI v3 transcript
// (`~/.kiro/sessions/cli/<uuid>.jsonl`, read 2026-08-17), not imagined. This
// repo has a documented history of Kiro parsers written against invented
// shapes that passed their own tests and matched nothing on disk, so the two
// properties such a fixture gets wrong are asserted explicitly:
//
//   - `data.meta.timestamp` is in SECONDS
//   - only `Prompt` carries a timestamp; `AssistantMessage` has none at all
//   - a `thinking` block's `data` is an OBJECT, which a careless parser
//     concatenates into the row as "[object Object]"

import XCTest
@testable import AgentDeck

final class LocalKiroObserverTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("kiro-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    private func write(_ lines: [String]) throws -> URL {
        let url = dir.appendingPathComponent("session.jsonl")
        try lines.joined(separator: "\n").write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    private func prompt(_ text: String, _ seconds: Int) -> String {
        """
        {"version":"v1","kind":"Prompt","data":{"message_id":"a6081b46","content":[{"kind":"text","data":"\(text)"}],"meta":{"timestamp":\(seconds)}}}
        """
    }

    private func assistant(_ text: String) -> String {
        """
        {"version":"v1","kind":"AssistantMessage","data":{"message_id":"66649d17","content":[{"kind":"thinking","data":{"text":"","signature":null}},{"kind":"text","data":"\(text)"}]}}
        """
    }

    func testPairsPromptsAndRepliesIntoTurns() throws {
        let url = try write([
            prompt("hello", 1786897401),
            assistant("Hello! How can I help you with AgentDeck today?"),
            prompt("hi", 1786933404),
            assistant("Hi!"),
        ])
        let turns = LocalKiroObserver.readTurns(url)
        XCTAssertEqual(turns.map(\.text), [
            "hello",
            "Hello! How can I help you with AgentDeck today?",
            "hi",
            "Hi!",
        ])
        XCTAssertEqual(turns.map(\.isPrompt), [true, false, true, false])
    }

    func testTimestampIsSecondsNotMilliseconds() throws {
        // 1786933404 is 2026-08-17. Read as milliseconds it lands in 1970,
        // which sorts before everything and vanishes under any `since`.
        let url = try write([prompt("hi", 1786933404), assistant("Hi!")])
        let turns = LocalKiroObserver.readTurns(url)
        XCTAssertEqual(turns[0].ts, 1786933404_000, accuracy: 0.5)
        // The assistant record carries NO timestamp, so it takes its prompt's —
        // nudged so it cannot sort before the thing it answers.
        XCTAssertEqual(turns[1].ts, turns[0].ts + 1, accuracy: 0.5)
    }

    func testThinkingBlocksAndToolResultsStayOutOfTheText() throws {
        let toolResults = """
        {"version":"v1","kind":"ToolResults","data":{"content":[{"kind":"toolResult","data":{"toolUseId":"tooluse_e6z"}}]}}
        """
        let url = try write([prompt("ls -la", 1786898236), toolResults, assistant("directory listing")])
        let turns = LocalKiroObserver.readTurns(url)
        XCTAssertEqual(turns.count, 2)
        let joined = turns.map(\.text).joined()
        XCTAssertFalse(joined.contains("object"), "thinking block leaked into the row text")
        XCTAssertFalse(joined.contains("toolUseId"), "tool result leaked into the row text")
    }

    func testUnreadableAndPartialLinesYieldNothingRatherThanGuesses() throws {
        XCTAssertEqual(LocalKiroObserver.readTurns(dir.appendingPathComponent("missing.jsonl")).count, 0)
        // A half-written tail line is normal on a live session.
        let url = try write([prompt("hi", 1786933404), "{\"kind\":\"AssistantMessage\",\"data\":{\"con"])
        XCTAssertEqual(LocalKiroObserver.readTurns(url).map(\.text), ["hi"])
    }

    func testObservationIsEmptyWithoutGrantedFolderAccess() throws {
        // The sandbox reaches ~/.kiro only through a user-granted bookmark. With
        // none, the observer must report nothing at all rather than a partial
        // or guessed session — this is the App Store behaviour by default.
        guard !AppPreferences.shared.hasKiroBookmark else {
            throw XCTSkip("a ~/.kiro bookmark is granted on this machine")
        }
        XCTAssertTrue(LocalKiroObserver.collect().isEmpty)
    }
}
#endif
