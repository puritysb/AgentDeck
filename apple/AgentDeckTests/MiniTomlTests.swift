#if os(macOS)
import XCTest
@testable import AgentDeck

final class MiniTomlTests: XCTestCase {

    // MARK: - applyManagedBlock

    func testApplyAppendsFenceWhenAbsent() {
        let original = """
        model = "gpt-5"

        [profiles.work]
        provider = "openai"
        """
        let body = "notify = [\"echo\", \"hi\"]"
        let updated = MiniToml.applyManagedBlock(in: original, body: body)

        XCTAssertTrue(updated.contains("model = \"gpt-5\""))
        XCTAssertTrue(updated.contains("[profiles.work]"))
        XCTAssertTrue(updated.contains("provider = \"openai\""))
        XCTAssertTrue(updated.contains(MiniToml.openFence))
        XCTAssertTrue(updated.contains(MiniToml.closeFence))
        XCTAssertTrue(updated.contains("notify = [\"echo\", \"hi\"]"))
    }

    func testApplyReplacesExistingFenceBlock() {
        let original = """
        model = "gpt-5"

        \(MiniToml.openFence)
        notify = ["old", "snippet"]
        \(MiniToml.closeFence)

        [profiles.work]
        provider = "openai"
        """
        let updated = MiniToml.applyManagedBlock(in: original, body: "notify = [\"new\", \"snippet\"]")

        XCTAssertFalse(updated.contains("\"old\", \"snippet\""))
        XCTAssertTrue(updated.contains("notify = [\"new\", \"snippet\"]"))
        // User content outside the fence still intact.
        XCTAssertTrue(updated.contains("model = \"gpt-5\""))
        XCTAssertTrue(updated.contains("[profiles.work]"))
        XCTAssertTrue(updated.contains("provider = \"openai\""))
    }

    func testApplyTwiceIsIdempotent() {
        let original = "model = \"gpt-5\"\n"
        let once = MiniToml.applyManagedBlock(in: original, body: "key = 1")
        let twice = MiniToml.applyManagedBlock(in: once, body: "key = 1")
        XCTAssertEqual(once, twice)
    }

    // MARK: - removeManagedBlock

    func testRemoveLeavesUserContent() {
        let original = """
        model = "gpt-5"

        [profiles.work]
        provider = "openai"
        """
        let withFence = MiniToml.applyManagedBlock(in: original, body: "notify = []")
        let stripped = MiniToml.removeManagedBlock(in: withFence)

        XCTAssertFalse(stripped.contains("notify"))
        XCTAssertFalse(stripped.contains(MiniToml.openFence))
        XCTAssertFalse(stripped.contains(MiniToml.closeFence))
        XCTAssertTrue(stripped.contains("model = \"gpt-5\""))
        XCTAssertTrue(stripped.contains("[profiles.work]"))
        XCTAssertTrue(stripped.contains("provider = \"openai\""))
    }

    func testRemoveIsIdempotentWithoutFence() {
        let original = "model = \"gpt-5\"\n"
        XCTAssertEqual(MiniToml.removeManagedBlock(in: original), original)
    }

    // MARK: - managed boolean in user table

    func testManagedBooleanAddsAndRemovesOnlyOwnedKey() {
        let original = """
        [features]
        js_repl = true
        memories = true

        [projects."/Users/me/project"]
        trust_level = "trusted"
        """
        let result = MiniToml.ensureManagedBoolean(
            in: original,
            table: "features",
            key: "hooks",
            value: true
        )

        XCTAssertEqual(result.status, .inserted)
        XCTAssertTrue(result.text.contains(MiniToml.featureOpenFence))
        XCTAssertTrue(result.text.contains("hooks = true"))
        XCTAssertTrue(result.text.contains(MiniToml.featureCloseFence))
        XCTAssertEqual(MiniToml.removeManagedBoolean(in: result.text), original)
    }

    func testManagedBooleanPreservesMatchingUserOwnedKey() {
        let original = """
        [features]
        js_repl = true
        hooks = true
        """
        let result = MiniToml.ensureManagedBoolean(
            in: original,
            table: "features",
            key: "hooks",
            value: true
        )

        XCTAssertEqual(result.status, .present)
        XCTAssertEqual(result.text, original)
        XCTAssertFalse(result.text.contains(MiniToml.featureOpenFence))
    }

    func testManagedBooleanRejectsExplicitConflict() {
        let original = """
        [features]
        js_repl = true
        hooks = false
        """
        let result = MiniToml.ensureManagedBoolean(
            in: original,
            table: "features",
            key: "hooks",
            value: true
        )

        XCTAssertEqual(result.status, .conflict("[features].hooks is already false"))
        XCTAssertEqual(result.text, original)
    }

    // MARK: - hasTopLevelKeyOutsideFence

    func testDetectsUserNotifyKey() {
        let withUser = """
        notify = ["python3", "/usr/local/bin/notify.py"]
        model = "gpt-5"
        """
        XCTAssertTrue(MiniToml.hasTopLevelKeyOutsideFence(in: withUser, key: "notify"))
    }

    func testIgnoresNotifyKeyInsideTable() {
        let inTable = """
        model = "gpt-5"

        [tui.notifications]
        notify = "always"
        """
        XCTAssertFalse(MiniToml.hasTopLevelKeyOutsideFence(in: inTable, key: "notify"))
    }

    func testIgnoresNotifyKeyInsideFence() {
        let original = "model = \"gpt-5\""
        let withFence = MiniToml.applyManagedBlock(in: original, body: "notify = [\"x\"]")
        XCTAssertFalse(MiniToml.hasTopLevelKeyOutsideFence(in: withFence, key: "notify"))
    }

    // MARK: - hasTableOutsideFence

    func testDetectsUserOtelTable() {
        let withUser = """
        model = "gpt-5"

        [otel]
        exporter = "none"
        """
        XCTAssertTrue(MiniToml.hasTableOutsideFence(in: withUser, table: "otel"))
    }

    func testDetectsUserOtelDottedTable() {
        let withUser = """
        [otel.exporter]
        kind = "otlp"
        """
        XCTAssertTrue(MiniToml.hasTableOutsideFence(in: withUser, table: "otel"))
    }

    func testDetectsArrayOfTableHeader() {
        let withUser = """
        [[hooks.Stop]]
        [[hooks.Stop.hooks]]
        type = "command"
        """
        XCTAssertTrue(MiniToml.hasTableOutsideFence(in: withUser, table: "hooks"))
    }

    func testIgnoresOtelInsideFence() {
        let withFence = MiniToml.applyManagedBlock(in: "", body: "[otel]\nexporter = \"otlp-http\"")
        XCTAssertFalse(MiniToml.hasTableOutsideFence(in: withFence, table: "otel"))
    }

    func testIgnoresOtelfooTable() {
        // Word boundary — `[otelfoo]` must not match `otel`.
        let withUnrelated = "[otelfoo]\nkey = 1"
        XCTAssertFalse(MiniToml.hasTableOutsideFence(in: withUnrelated, table: "otel"))
    }

    // MARK: - quoted

    func testQuotedEscapesBackslashAndQuote() {
        XCTAssertEqual(MiniToml.quoted("a\\b\"c"), "\"a\\\\b\\\"c\"")
    }

    func testQuotedEscapesNewlineAndTab() {
        XCTAssertEqual(MiniToml.quoted("a\nb\tc"), "\"a\\nb\\tc\"")
    }

    func testQuotedSimpleAscii() {
        XCTAssertEqual(MiniToml.quoted("hello"), "\"hello\"")
    }

    // MARK: - Lossless roundtrip

    func testRoundtripPreservesArbitraryStructure() {
        let original = """
        # Codex config — handcrafted

        model = "gpt-5"
        approval_policy = "on-request"

        [profiles.work]
        provider = "openai"
        approval_policy = "never"

        [mcp_servers.foo]
        command = "/usr/local/bin/foo-server"
        args = ["--port", "9000"]

        [history]
        max_bytes = 10485760
        """
        let body = "[otel]\nexporter = \"otlp-http\""
        let withFence = MiniToml.applyManagedBlock(in: original, body: body)
        let stripped = MiniToml.removeManagedBlock(in: withFence)
        // After apply+remove the file should be byte-identical to the original.
        XCTAssertEqual(stripped, original)
    }
}
#endif
