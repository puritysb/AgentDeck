import XCTest
@testable import AgentDeck

final class AppMetadataTests: XCTestCase {
    func testReleaseIdentityTracksBundleAcrossUpgrades() {
        for version in ["1.8.0", "2.4.1"] {
            let metadata = AppMetadata(info: [
                "CFBundleDisplayName": "AgentDeck Preview",
                "CFBundleName": "AgentDeck",
                "CFBundleShortVersionString": version,
                "CFBundleVersion": "42",
                "CFBundleIdentifier": "example.preview",
            ])
            XCTAssertEqual(metadata.name, "AgentDeck Preview")
            XCTAssertEqual(metadata.version, version)
            XCTAssertEqual(metadata.build, "42")
            XCTAssertEqual(metadata.bundleIdentifier, "example.preview")
        }
    }

    func testMissingOrUnexpandedMetadataDoesNotInventARelease() {
        for info: [String: Any] in [[:], [
            "CFBundleDisplayName": " ",
            "CFBundleShortVersionString": "$(MARKETING_VERSION)",
            "CFBundleVersion": 42,
            "CFBundleIdentifier": "\n",
        ]] {
            let metadata = AppMetadata(info: info)
            XCTAssertEqual(metadata.name, "AgentDeck")
            XCTAssertEqual(metadata.version, "Unknown")
            XCTAssertEqual(metadata.build, "Unknown")
            XCTAssertEqual(metadata.bundleIdentifier, "Unknown")
        }
        XCTAssertEqual(AppMetadata(info: ["CFBundleName": " Preview "]).name, "Preview")
    }

    func testReviewAndInstallLinksUseTheSamePublishedListing() {
        XCTAssertEqual(AppMetadata.appStoreURL.path, AppMetadata.reviewURL.path)
        XCTAssertNil(AppMetadata.appStoreURL.query)
        XCTAssertEqual(AppMetadata.reviewURL.query, "action=write-review")
    }

    func testBuiltAppContainsResolvedReleaseMetadata() {
        XCTAssertNotEqual(AppMetadata.current.version, "Unknown")
        XCTAssertNotEqual(AppMetadata.current.build, "Unknown")
        XCTAssertEqual(AppMetadata.current.bundleIdentifier, "bound.serendipity.agent.deck")
    }
}
