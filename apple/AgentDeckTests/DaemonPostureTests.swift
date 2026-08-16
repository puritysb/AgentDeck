#if os(macOS)
import XCTest
@testable import AgentDeck

/// Mirrors the cases of `bridge/src/__tests__/network-posture.test.ts` for the
/// module-gating rules the two daemons must answer identically. Pure struct —
/// no actor, so plain synchronous XCTest is correct here.
final class DaemonPostureTests: XCTestCase {
    private let open = DaemonPosture.open
    private let loopback = DaemonPosture(loopbackOnly: true, noDeviceModules: false)
    private let local = DaemonPosture(loopbackOnly: false, noDeviceModules: true)
    private let both = DaemonPosture(loopbackOnly: true, noDeviceModules: true)

    /// Every module DaemonServer.startDeviceModules can register. Keep in sync
    /// with the `allowsModule` call sites there — a name listed here and never
    /// gated in startDeviceModules would make this test vacuous for it.
    private let registeredModules = ["adb", "serial", "pixoo", "timebox", "idotmatrix"]

    func testOpenPostureAllowsEverything() {
        for name in registeredModules {
            XCTAssertTrue(open.allowsModule(name), "\(name) must run in the open posture")
        }
        XCTAssertTrue(open.advertisesOnLAN)
    }

    func testLoopbackSilencesEveryModuleThatTouchesTheNetwork() {
        XCTAssertFalse(loopback.allowsModule("pixoo"))
        XCTAssertFalse(loopback.allowsModule("timebox"))
        XCTAssertFalse(loopback.allowsModule("idotmatrix"))
        XCTAssertFalse(loopback.advertisesOnLAN)
    }

    func testLoopbackKeepsTheUsbChannels() {
        // A board on a cable is not a network peer; the Swift AdbModule is a
        // stub, but the answer to "what runs under loopback?" must match Node.
        XCTAssertTrue(loopback.allowsModule("serial"))
        XCTAssertTrue(loopback.allowsModule("adb"))
    }

    func testLocalTurnsOffEveryModuleSerialIncluded() {
        for name in registeredModules {
            XCTAssertFalse(local.allowsModule(name), "\(name) must be off under noDeviceModules")
        }
        // --local still binds all interfaces, so the advertisement stays: a
        // paired companion should keep discovering the daemon.
        XCTAssertTrue(local.advertisesOnLAN)
    }

    func testLocalWinsOverLoopbackWhenBothAreSet() {
        XCTAssertFalse(both.allowsModule("serial"))
        XCTAssertFalse(both.allowsModule("adb"))
        XCTAssertFalse(both.advertisesOnLAN)
    }

    func testAModuleAddedLaterDefaultsToOffInBothRestrictedPostures() {
        // Guards the shape, not a specific module: an unknown name must fail
        // safe as "off" under any restricted posture, never "on".
        for posture in [loopback, local, both] {
            XCTAssertFalse(posture.allowsModule("some-future-module"))
        }
        XCTAssertTrue(open.allowsModule("some-future-module"))
    }

    func testDescribeNamesWhatIsOffNotJustTheBindAddress() {
        let line = loopback.describe(port: 9120)
        XCTAssertTrue(line.contains("127.0.0.1:9120"))
        for claim in ["Bonjour", "Pixoo", "BLE"] {
            XCTAssertTrue(line.contains(claim), "posture line must mention \(claim)")
        }
        XCTAssertTrue(line.contains("USB serial stays on"))

        let bothLine = both.describe(port: 9120)
        XCTAssertTrue(bothLine.contains("USB serial are all off"))
        XCTAssertFalse(bothLine.contains("stays on"))
    }

    func testHealthDictMatchesTheNodeWireShape() {
        // `agentdeck qr`/`pair`/`daemon restart` read health.posture.loopbackOnly
        // off either daemon — the key names are the contract.
        let dict = loopback.healthDict
        XCTAssertEqual(dict["loopbackOnly"] as? Bool, true)
        XCTAssertEqual(dict["noDeviceModules"] as? Bool, false)
    }
}
#endif
