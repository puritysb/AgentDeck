// PairingCredentialTests.swift — a discovered endpoint must not un-pair a device.
//
// Case-for-case mirror of Android's `PairingCredentialTest`. Keep the two in
// step: they encode one cross-platform contract, not two implementations.

import XCTest
@testable import AgentDeck

final class PairingCredentialTests: XCTestCase {

    private let paired = "ws://192.168.1.10:9120?token=abcdef0123456789abcdef0123456789"
    private let discovered = "ws://192.168.1.10:9120"

    // MARK: - Endpoint identity

    func testCredentialIsNotPartOfDaemonIdentity() {
        XCTAssertTrue(PairingCredential.sameEndpoint(discovered, paired),
                      "a token-bearing URL and its tokenless twin are the same daemon")
    }

    func testDefaultPortMatchesExplicitDefaultPort() {
        XCTAssertTrue(PairingCredential.sameEndpoint("ws://192.168.1.10", "ws://192.168.1.10:9120"))
    }

    func testDifferentHostOrPortAreDifferentDaemons() {
        XCTAssertFalse(PairingCredential.sameEndpoint(discovered, "ws://192.168.1.11:9120"))
        XCTAssertFalse(PairingCredential.sameEndpoint(discovered, "ws://192.168.1.10:9125"))
    }

    func testUnparseableInputsNeverCompareEqual() {
        XCTAssertFalse(PairingCredential.sameEndpoint(nil, nil))
        XCTAssertFalse(PairingCredential.sameEndpoint(discovered, nil))
        XCTAssertFalse(PairingCredential.sameEndpoint("not a url", "not a url"))
    }

    // MARK: - Token extraction

    func testTokenExtraction() {
        XCTAssertEqual(PairingCredential.token(in: paired), "abcdef0123456789abcdef0123456789")
        XCTAssertNil(PairingCredential.token(in: discovered))
        XCTAssertNil(PairingCredential.token(in: "ws://192.168.1.10:9120?token="),
                     "an empty token is absent, not a credential")
        XCTAssertNil(PairingCredential.token(in: nil))
    }

    // MARK: - Resolution — the regression this file exists for

    func testPairedEndpointInheritsItsStoredCredential() {
        XCTAssertEqual(PairingCredential.resolve(discoveredUrl: discovered, savedUrl: paired), paired,
                       "rediscovering the daemon we are paired with must not drop the token")
    }

    func testDifferentDaemonDoesNotInheritAnotherEndpointsCredential() {
        let other = "ws://192.168.1.11:9120"
        XCTAssertEqual(PairingCredential.resolve(discoveredUrl: other, savedUrl: paired), other,
                       "a credential belongs to one daemon; never present it to another")
    }

    func testNoStoredCredentialLeavesTheDiscoveredUrlUntouched() {
        XCTAssertEqual(PairingCredential.resolve(discoveredUrl: discovered, savedUrl: nil), discovered)
        XCTAssertEqual(PairingCredential.resolve(discoveredUrl: discovered, savedUrl: discovered), discovered)
    }

    func testAnExplicitlyCredentialedDiscoveryWins() {
        // A pre-#145 daemon may still advertise a token; it is authoritative.
        let legacy = "ws://192.168.1.10:9120?token=1111111111111111"
        XCTAssertEqual(PairingCredential.resolve(discoveredUrl: legacy, savedUrl: paired), legacy)
    }
    func testSwitchingHostsRetainsIndependentCredentials() {
        let other = "ws://192.168.1.11:9120?token=other"
        var saved = PairingCredential.remembering(paired, in: [:])
        saved = PairingCredential.remembering(other, in: saved)
        saved = PairingCredential.remembering(discovered, in: saved)
        XCTAssertEqual(PairingCredential.resolve(discoveredUrl: discovered, credentials: saved), paired)
        XCTAssertEqual(PairingCredential.resolve(discoveredUrl: "ws://192.168.1.11:9120", credentials: saved), other)
        XCTAssertEqual(PairingCredential.resolve(discoveredUrl: "ws://192.168.1.12:9120", credentials: saved), "ws://192.168.1.12:9120")
    }

    func testDiscoveryPreservesSelectionAndRequiresChoiceWhenAmbiguous() {
        let other = "ws://192.168.1.11:9120"
        XCTAssertNil(PairingCredential.preferredURL(in: [other, discovered], selected: nil))
        XCTAssertEqual(PairingCredential.preferredURL(in: [other, discovered], selected: paired), discovered)
        XCTAssertNil(PairingCredential.preferredURL(in: [other], selected: paired))
        XCTAssertEqual(PairingCredential.preferredURL(in: [discovered, discovered], selected: nil), discovered)
    }

}
