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
        notify = ["old", "agentdeck-notify"]
        \(MiniToml.closeFence)

        [profiles.work]
        provider = "openai"
        """
        let updated = MiniToml.applyManagedBlock(in: original, body: "notify = [\"new\", \"snippet\"]")

        XCTAssertFalse(updated.contains("\"old\", \"agentdeck-notify\""))
        XCTAssertTrue(updated.contains("notify = [\"new\", \"snippet\"]"))
        // User content outside the fence still intact.
        XCTAssertTrue(updated.contains("model = \"gpt-5\""))
        XCTAssertTrue(updated.contains("[profiles.work]"))
        XCTAssertTrue(updated.contains("provider = \"openai\""))
    }

    func testApplyTwiceIsIdempotent() {
        let original = "model = \"gpt-5\"\n"
        let once = MiniToml.applyManagedBlock(in: original, body: "[features]\nhooks = true")
        let twice = MiniToml.applyManagedBlock(in: once, body: "[features]\nhooks = true")
        XCTAssertEqual(once, twice)
    }

    // MARK: - removeManagedBlock

    func testRemoveLeavesUserContent() {
        let original = """
        model = "gpt-5"

        [profiles.work]
        provider = "openai"
        """
        let withFence = MiniToml.applyManagedBlock(in: original, body: "notify = [\"agentdeck-notify\"]")
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

    func testMergeableLifecycleHookArraysAreCompatible() {
        let hooks = """
        [[hooks.PostToolUse]]
        [[hooks.PostToolUse.hooks]]
        type = "command"
        command = "workmux set-window-status working"

        [[hooks.SubagentStop]]
        [[hooks.SubagentStop.hooks]]
        type = "command"
        command = "workmux set-window-status done"
        """
        XCTAssertFalse(MiniToml.hasIncompatibleHookTableOutsideFence(in: hooks))
    }

    func testRegularHookTablesAreIncompatibleButTrustStateIsNot() {
        XCTAssertTrue(MiniToml.hasIncompatibleHookTableOutsideFence(
            in: "[hooks]\nmanaged_dir = \"/tmp/hooks\""
        ))
        XCTAssertTrue(MiniToml.hasIncompatibleHookTableOutsideFence(
            in: "[hooks.Stop]\ncommand = \"legacy\""
        ))
        XCTAssertFalse(MiniToml.hasIncompatibleHookTableOutsideFence(
            in: "[hooks.state]\n[hooks.state.\"/tmp/config.toml:stop:0:0\"]\ntrusted_hash = \"sha256:abc\""
        ))
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
        let body = "[features]\nhooks = true"
        let withFence = MiniToml.applyManagedBlock(in: original, body: body)
        let stripped = MiniToml.removeManagedBlock(in: withFence)
        // After apply+remove the file should be byte-identical to the original.
        XCTAssertEqual(stripped, original)
    }
}
#endif
