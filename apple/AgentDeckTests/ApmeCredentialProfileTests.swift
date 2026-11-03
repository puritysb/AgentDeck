import XCTest
@testable import AgentDeck

final class ApmeCredentialProfileTests: XCTestCase {
    private final class Store: @unchecked Sendable {
        private let lock = NSLock()
        private var value: String?
        var failSave = false
        init(_ value: String? = nil) { self.value = value }
        var storage: ApmeAPIKeyStorage {
            .init(load: { self.lock.lock(); defer { self.lock.unlock() }; return self.value },
                  save: { key in
                self.lock.lock(); defer { self.lock.unlock() }
                if self.failSave { throw CocoaError(.fileWriteNoPermission) }
                self.value = key
            })
        }
    }

    private func fixture(_ body: (UserDefaults, URL) throws -> Void) throws {
        let name = "ApmeCredentialProfileTests." + UUID().uuidString
        let defaults = UserDefaults(suiteName: name)!
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { defaults.removePersistentDomain(forName: name); try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("settings.json")
        try Data(#"{"unrelated":7,"apme":{"judge":{"apiKey":"legacy-file","model":"model"}}}"#.utf8).write(to: url)
        try body(defaults, url)
    }

    func testMigratesOnlyAfterSecureAcknowledgementAndPreservesOtherSettings() throws {
        try fixture { defaults, url in
            defaults.set("legacy-defaults", forKey: ApmeCredentialProfile.legacyKey)
            let store = Store()
            let profile = ApmeCredentialProfile(defaults: defaults, storage: store.storage, url: url)
            XCTAssertEqual(try profile.migrate(), "legacy-defaults")
            XCTAssertEqual(try store.storage.load(), "legacy-defaults")
            XCTAssertNil(defaults.object(forKey: ApmeCredentialProfile.legacyKey))
            let root = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
            XCTAssertEqual(root["unrelated"] as? Int, 7)
            let judge = (root["apme"] as! [String: Any])["judge"] as! [String: Any]
            XCTAssertNil(judge["apiKey"])
            XCTAssertEqual(judge["model"] as? String, "model")
            let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
            XCTAssertEqual((attrs[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        }
    }

    func testFailedSecureWriteRetainsBothLegacyCopies() throws {
        try fixture { defaults, url in
            defaults.set("legacy-defaults", forKey: ApmeCredentialProfile.legacyKey)
            let original = try Data(contentsOf: url)
            let store = Store(); store.failSave = true
            let profile = ApmeCredentialProfile(defaults: defaults, storage: store.storage, url: url)
            XCTAssertThrowsError(try profile.migrate())
            XCTAssertEqual(defaults.string(forKey: ApmeCredentialProfile.legacyKey), "legacy-defaults")
            XCTAssertEqual(try Data(contentsOf: url), original)
            // Editing non-secret settings must not scrub a credential whose
            // migration was refused, or create a new plaintext credential.
            try profile.writeConfiguration(key: "", backend: "openai", endpoint: "", model: "")
            XCTAssertEqual(try Data(contentsOf: url), original)
        }
    }

    func testSecureClearSurvivesRestartAndDoesNotReviveStaleFile() throws {
        try fixture { defaults, url in
            let store = Store("secure-key")
            let profile = ApmeCredentialProfile(defaults: defaults, storage: store.storage, url: url)
            XCTAssertEqual(try profile.migrate(), "secure-key")
            try profile.save("", backend: "openai", endpoint: "https://example.invalid", model: "model")
            // Simulate a legacy profile restored after clear.
            try Data(#"{"apme":{"judge":{"apiKey":"stale-restored"}}}"#.utf8).write(to: url)
            let restarted = ApmeCredentialProfile(defaults: defaults, storage: store.storage, url: url)
            XCTAssertEqual(try restarted.migrate(), "")
            XCTAssertNil(try ApmeAPIKeyStorage.resolve(configured: "stale-restored", storage: store.storage))
            XCTAssertFalse(try String(contentsOf: url, encoding: .utf8).contains("stale-restored"))
        }
    }

    func testSecureReadFailureDoesNotFallBackToPlaintext() {
        let unavailable = ApmeAPIKeyStorage(load: { throw CocoaError(.fileReadNoPermission) }, save: { _ in })
        XCTAssertThrowsError(try ApmeAPIKeyStorage.resolve(configured: "plaintext", storage: unavailable))
        XCTAssertNil(try ApmeAPIKeyStorage.resolve(configured: "plaintext", storage: Store().storage))
        XCTAssertEqual(try ApmeAPIKeyStorage.resolve(configured: "cli-key", storage: nil), "cli-key")
    }

    func testDeveloperProfileRetainsCLIContractWithPrivatePermissions() throws {
        try fixture { defaults, url in
            defaults.set("dev-key", forKey: ApmeCredentialProfile.legacyKey)
            let profile = ApmeCredentialProfile(defaults: defaults, storage: nil, url: url)
            XCTAssertEqual(try profile.migrate(), "dev-key")
            XCTAssertNil(defaults.object(forKey: ApmeCredentialProfile.legacyKey))
            XCTAssertTrue(try String(contentsOf: url, encoding: .utf8).contains("dev-key"))
            let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
            XCTAssertEqual((attrs[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        }
    }

    func testPreferencesSaveThroughSecureStoreWithoutDefaultsMirrorAndReportFailure() throws {
        try fixture { defaults, url in
            let store = Store()
            let preferences = AppPreferences(defaults: defaults, apmeKeyStorage: store.storage, apmeSettingsURL: url)
            preferences.apmeJudgeApiKey = "new-secure-key"
            XCTAssertEqual(try store.storage.load(), "new-secure-key")
            XCTAssertNil(defaults.object(forKey: ApmeCredentialProfile.legacyKey))
            XCTAssertFalse(try String(contentsOf: url, encoding: .utf8).contains("new-secure-key"))
            store.failSave = true
            preferences.apmeJudgeApiKey = "refused-key"
            XCTAssertFalse(preferences.apmeJudgeCredentialNotice.isEmpty)
            XCTAssertEqual(try store.storage.load(), "new-secure-key")
            XCTAssertFalse(try String(contentsOf: url, encoding: .utf8).contains("refused-key"))
        }
    }

    func testInertProfileDoesNotReturnLegacyDefaultsCredential() throws {
        try fixture { defaults, _ in
            defaults.set("unrelated-user-key", forKey: ApmeCredentialProfile.legacyKey)
            let inert = ApmeCredentialProfile(defaults: defaults, storage: nil, url: nil)
            XCTAssertEqual(try inert.migrate(), "")
            XCTAssertEqual(defaults.string(forKey: ApmeCredentialProfile.legacyKey), "unrelated-user-key")
        }
    }

    func testHostedProviderReadsOnlyExplicitFixtureAndIgnoresInheritedEnvironmentKey() throws {
        try fixture { _, url in
            let hosted = ["XCTestBundlePath": "synthetic-test-host", "ANTHROPIC_API_KEY": "inherited-key"]
            XCTAssertNil(ApmeSettings.resolvedSettingsPath(environment: hosted))
            XCTAssertNil(ApmeSettings.load(environment: hosted).judge.apiKey)
            #if os(macOS)
            XCTAssertNil(ApmeJudgeApi.loadApiKey(environment: hosted))
            #endif
            var explicit = hosted
            explicit["AGENTDECK_DATA_DIR"] = url.deletingLastPathComponent().path
            XCTAssertEqual(ApmeSettings.load(environment: explicit).judge.apiKey, "legacy-file")
            #if os(macOS)
            XCTAssertEqual(ApmeJudgeApi.loadApiKey(environment: explicit), "legacy-file")
            #endif
        }
    }

    func testMalformedProfileIsPreservedOnMigrationFailure() throws {
        try fixture { defaults, url in
            let corrupt = Data("not json".utf8); try corrupt.write(to: url)
            let store = Store()
            let profile = ApmeCredentialProfile(defaults: defaults, storage: store.storage, url: url)
            XCTAssertThrowsError(try profile.migrate())
            XCTAssertEqual(try Data(contentsOf: url), corrupt)
            XCTAssertNil(try store.storage.load())
        }
    }
}
