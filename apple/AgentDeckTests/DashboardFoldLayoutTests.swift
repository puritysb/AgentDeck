import XCTest
@testable import AgentDeck

/// Geometry is shaped after the iPhone Duo simulator (iOS 27.1): inner display
/// 951 × 669 pt landscape / 669 × 951 pt portrait, a ~40 pt division band with
/// the system's margins, and the Dashboard's safe-area-reduced bounds.
final class DashboardFoldLayoutTests: XCTestCase {
    private let sand: CGFloat = 0.35
    private let bookBounds = CGSize(width: 856, height: 669)
    private let bookCrease = CGRect(x: 455, y: 0, width: 40, height: 669)
    private let deskBounds = CGSize(width: 669, height: 780)
    private let deskCrease = CGRect(x: 0, y: 360, width: 669, height: 40)

    // MARK: Posture

    func testNoDivisionKeepsContinuousLayout() {
        XCTAssertEqual(DashboardFoldLayout.posture(bounds: bookBounds, divisions: []), .continuous)
        XCTAssertNil(DashboardFoldLayout.frames(
            posture: .continuous, bounds: bookBounds, sandFraction: sand,
            attentionHeight: 0, showsSessions: true, showsSystem: true))
    }

    func testVerticalCreaseSplitsSideBySideAroundTheBand() {
        guard case .sideBySide(let leading, let trailing) =
                DashboardFoldLayout.posture(bounds: bookBounds, divisions: [bookCrease]) else {
            return XCTFail("vertical division should split left/right")
        }
        XCTAssertEqual(leading.maxX, bookCrease.minX)
        XCTAssertEqual(trailing.minX, bookCrease.maxX)
        XCTAssertEqual(trailing.maxX, bookBounds.width)
    }

    func testHorizontalCreaseStacksAroundTheBand() {
        guard case .stacked(let upper, let lower) =
                DashboardFoldLayout.posture(bounds: deskBounds, divisions: [deskCrease]) else {
            return XCTFail("horizontal division should split top/bottom")
        }
        XCTAssertEqual(upper.maxY, deskCrease.minY)
        XCTAssertEqual(lower.minY, deskCrease.maxY)
        XCTAssertEqual(lower.maxY, deskBounds.height)
    }

    func testDivisionNearAnEdgeIsNotWorthTwoPanes() {
        let nearEdge = CGRect(x: 120, y: 0, width: 40, height: 669)
        XCTAssertEqual(DashboardFoldLayout.posture(bounds: bookBounds, divisions: [nearEdge]), .continuous)
    }

    func testDivisionOutsideTheDashboardIsIgnored() {
        let elsewhere = CGRect(x: 2_000, y: 0, width: 40, height: 669)
        XCTAssertEqual(DashboardFoldLayout.posture(bounds: bookBounds, divisions: [elsewhere]), .continuous)
    }

    // MARK: Frames — nothing interactive on the crease

    func testSideBySideKeepsEveryControlOffTheCrease() throws {
        let posture = DashboardFoldLayout.posture(bounds: bookBounds, divisions: [bookCrease])
        let frames = try XCTUnwrap(DashboardFoldLayout.frames(
            posture: posture, bounds: bookBounds, sandFraction: sand,
            attentionHeight: 140, showsSessions: true, showsSystem: true))
        for rect in [frames.attention, try XCTUnwrap(frames.sessions), try XCTUnwrap(frames.system), frames.timeline] {
            XCTAssertFalse(rect.intersects(bookCrease), "\(rect) crosses the crease")
        }
        // Attention and roster share the leading pane, roster below the card.
        XCTAssertLessThan(frames.attention.maxX, bookCrease.minX)
        XCTAssertEqual(try XCTUnwrap(frames.sessions).minY, frames.attention.minY + 140 + DashboardFoldLayout.paneGap)
        // Usage and Timeline share the trailing pane; Timeline keeps the sand share.
        XCTAssertGreaterThanOrEqual(frames.timeline.minX, bookCrease.maxX)
        XCTAssertEqual(frames.timeline.height, bookBounds.height * sand, accuracy: 0.5)
        XCTAssertLessThanOrEqual(try XCTUnwrap(frames.system).maxY, frames.timeline.minY)
        XCTAssertFalse(frames.sharesRail)
        XCTAssertNil(frames.deck, "the habitat spans both panes")
    }

    func testStackedPutsTheHabitatAboveAndEveryControlBelow() throws {
        let posture = DashboardFoldLayout.posture(bounds: deskBounds, divisions: [deskCrease])
        let frames = try XCTUnwrap(DashboardFoldLayout.frames(
            posture: posture, bounds: deskBounds, sandFraction: sand,
            attentionHeight: 150, showsSessions: true, showsSystem: true))
        // Mostly water above the crease: only a thin sand band stays there and
        // the rest of the bed continues under the deck.
        let upperHeight = deskCrease.minY
        let waterline = frames.terrarium.minY + frames.terrarium.height * (1 - sand)
        XCTAssertEqual(waterline, upperHeight * (1 - DashboardFoldLayout.stackedUpperSandShare), accuracy: 0.5)
        XCTAssertLessThan(waterline, deskCrease.minY)
        XCTAssertGreaterThan(frames.terrarium.maxY, deskCrease.maxY)
        XCTAssertLessThanOrEqual(frames.terrarium.maxY, deskBounds.height)
        XCTAssertEqual(frames.notice, CGRect(x: 0, y: 0, width: deskBounds.width, height: upperHeight))
        XCTAssertEqual(frames.deck?.minY, deskCrease.maxY)
        for rect in [frames.attention, try XCTUnwrap(frames.sessions), frames.timeline] {
            XCTAssertGreaterThanOrEqual(rect.minY, deskCrease.maxY, "\(rect) is not on the control deck")
            XCTAssertLessThanOrEqual(rect.maxY, deskBounds.height)
        }
        XCTAssertTrue(frames.sharesRail, "Sessions and System share one switched rail")
        // The Timeline yields to the attention card instead of hiding under it.
        XCTAssertEqual(frames.timeline.minY, frames.attention.minY + 150 + DashboardFoldLayout.paneGap)
        XCTAssertFalse(try XCTUnwrap(frames.sessions).intersects(frames.timeline))
    }

    func testStackedWithoutRailsGivesTheCentreTheFullDeck() throws {
        let posture = DashboardFoldLayout.posture(bounds: deskBounds, divisions: [deskCrease])
        let frames = try XCTUnwrap(DashboardFoldLayout.frames(
            posture: posture, bounds: deskBounds, sandFraction: sand,
            attentionHeight: 0, showsSessions: false, showsSystem: false))
        XCTAssertNil(frames.sessions)
        XCTAssertNil(frames.system)
        XCTAssertEqual(frames.timeline.width, deskBounds.width - 2 * DashboardFoldLayout.edgePadding)
    }

    // MARK: Continuous landscape attention placement

    func testFlatDuoNarrowsTheAttentionCardToTheGapBetweenRails() {
        let placement = DashboardHUDLayout.landscapeAttentionPlacement(
            availableWidth: 856, showsSessions: true, showsSystem: true)
        let leading = DashboardHUDLayout.edgePadding + DashboardHUDLayout.sessionPanelWidth(availableWidth: 856)
            + DashboardHUDLayout.timelineClearance
        let trailing = DashboardHUDLayout.edgePadding + DashboardHUDLayout.rightRailWidth(availableWidth: 856)
            + DashboardHUDLayout.timelineClearance
        XCTAssertEqual(placement.width, 856 - leading - trailing, accuracy: 0.5)
        XCTAssertLessThan(placement.width, DashboardHUDLayout.attentionPreferredWidth)
        // Centred on the gap: left edge lands just past the session rail.
        XCTAssertEqual(856 / 2 + placement.centreOffset - placement.width / 2, leading, accuracy: 0.5)
    }

    func testPhoneLandscapeAndIPadKeepTheEstablishedCard() {
        // Largest iPhone landscape Dashboard (956 pt minus both sensor insets)
        // and iPad landscape widths: unchanged 460 pt centred card.
        for width: CGFloat in [667, 724, 832, 1_080, 1_133, 1_194, 1_366] {
            let placement = DashboardHUDLayout.landscapeAttentionPlacement(
                availableWidth: width, showsSessions: true, showsSystem: true)
            XCTAssertEqual(placement.width, DashboardHUDLayout.attentionPreferredWidth, "width \(width)")
            XCTAssertEqual(placement.centreOffset, 0, "width \(width)")
        }
    }
}
