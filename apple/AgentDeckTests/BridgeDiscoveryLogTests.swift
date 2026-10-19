// BridgeDiscoveryLogTests.swift — the discovery browse log names a TXT
// record's keys, never its values.
//
// An older daemon advertised its pairing token in TXT, and the browse log
// reaches the Xcode console and diagnostic bundles.

import Network
import XCTest
@testable import AgentDeck

final class BridgeDiscoveryLogTests: XCTestCase {

    func testTxtKeysNameEveryKeyAndNoValue() {
        let record = NWTXTRecord(["agent": "daemon", "token": "not-a-real-token", "v": "3"])
        let keys = BridgeDiscovery.txtKeys(.bonjour(record))
        XCTAssertEqual(keys, ["agent", "token", "v"])
        XCTAssertFalse("\(keys)".contains("not-a-real-token"))
    }

    func testAResultWithoutATxtRecordHasNoKeys() {
        XCTAssertEqual(BridgeDiscovery.txtKeys(.none), [])
    }
}
