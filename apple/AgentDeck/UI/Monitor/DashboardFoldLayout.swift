// DashboardFoldLayout.swift — Dashboard composition for foldable displays (iPhone Duo)
//
// The system reports where content must split through
// `ReservedRegion.Kind.division` (iOS 27.1). This file turns that geometry into
// frames for each Dashboard element so no interactive control lands on the
// crease. It is pure geometry: the observing view lives in MonitorScreen, and
// both macOS and iOS test targets exercise this file.

import CoreGraphics
import SwiftUI

/// How the Dashboard is split by a display division.
enum DashboardFoldPosture: Equatable {
    /// No active division, or one too close to an edge to host two readable
    /// panes. Every existing layout (iPhone, iPad, macOS, the Duo's cover
    /// display) takes this path unchanged.
    case continuous
    /// Vertical crease — the unfolded Duo held as a book. Leading pane carries
    /// attention and the full-height session roster, trailing pane carries
    /// usage/services and the Timeline.
    case sideBySide(leading: CGRect, trailing: CGRect)
    /// Horizontal crease — the unfolded Duo upright, typically propped half
    /// open on a desk. The upper pane is the habitat; the lower pane is the
    /// control deck where every answer button and list sits within thumb reach.
    case stacked(upper: CGRect, lower: CGRect)

    var isFolded: Bool { self != .continuous }
}

/// Frames for every Dashboard element in the Dashboard's coordinate space.
/// Only produced for a folded posture; `nil` means "use the existing layout".
struct DashboardFoldFrames: Equatable {
    var posture: DashboardFoldPosture
    /// Where the habitat renders.
    var terrarium: CGRect
    /// Opaque deck behind the controls, when the habitat does not extend there.
    var deck: CGRect?
    /// Attention card: origin and width; its height is the card's own.
    var attention: CGRect
    /// Session roster. Equal to `system` when one rail shows both behind a switch.
    var sessions: CGRect?
    /// Usage & Services rail.
    var system: CGRect?
    var timeline: CGRect
    /// Region whose bottom edge anchors transient cards (Setup, toasts).
    var notice: CGRect

    /// One rail hosts Sessions and System behind the compact switcher.
    var sharesRail: Bool { sessions != nil && sessions == system }
}

enum DashboardFoldLayout {
    static let edgePadding: CGFloat = 12
    static let paneGap: CGFloat = 12
    /// Narrower than this and a pane cannot hold the 220 pt session rail plus
    /// its padding; keep the continuous layout instead of two cramped panes.
    static let minimumPaneWidth: CGFloat = 260
    static let minimumPaneHeight: CGFloat = 220
    /// Below this a Timeline strip cannot show a single grouped row.
    static let minimumTimelineHeight: CGFloat = 72

    /// Classify the first active division that crosses `bounds`.
    ///
    /// `divisions` are frames already converted to the Dashboard's space
    /// (including the margins the system reserves around the hinge). A
    /// division taller than wide splits left/right; wider than tall splits
    /// top/bottom.
    static func posture(bounds: CGSize, divisions: [CGRect]) -> DashboardFoldPosture {
        let rect = CGRect(origin: .zero, size: bounds)
        guard rect.width > 0, rect.height > 0 else { return .continuous }
        for division in divisions {
            let crease = division.intersection(rect)
            guard !crease.isNull, crease.width > 0 || crease.height > 0 else { continue }
            if division.height >= division.width {
                let leading = CGRect(x: 0, y: 0, width: crease.minX, height: rect.height)
                let trailing = CGRect(x: crease.maxX, y: 0, width: rect.width - crease.maxX, height: rect.height)
                guard leading.width >= minimumPaneWidth, trailing.width >= minimumPaneWidth else {
                    return .continuous
                }
                return .sideBySide(leading: leading, trailing: trailing)
            } else {
                let upper = CGRect(x: 0, y: 0, width: rect.width, height: crease.minY)
                let lower = CGRect(x: 0, y: crease.maxY, width: rect.width, height: rect.height - crease.maxY)
                guard upper.height >= minimumPaneHeight, lower.height >= minimumPaneHeight else {
                    return .continuous
                }
                return .stacked(upper: upper, lower: lower)
            }
        }
        return .continuous
    }

    /// - Parameters:
    ///   - sandFraction: share of the height the Timeline/sand bed occupies in
    ///     the continuous layout (TerrariumLayout SSOT); the side-by-side
    ///     trailing pane keeps that proportion.
    ///   - attentionHeight: measured height of the attention card when one is
    ///     showing, else 0. Panels below it move down instead of being covered.
    ///   - showsSessions / showsSystem: the user's rail preferences.
    /// Share of the upper pane the sand bed keeps in the stacked posture. The
    /// habitat's own sand share (35%) left a thick band of floor above the
    /// crease; the rest of the bed now lies below it, behind the deck (#799).
    static let stackedUpperSandShare: CGFloat = 0.12

    static func frames(
        posture: DashboardFoldPosture,
        bounds: CGSize,
        sandFraction: CGFloat,
        attentionHeight: CGFloat,
        showsSessions: Bool,
        showsSystem: Bool
    ) -> DashboardFoldFrames? {
        let full = CGRect(origin: .zero, size: bounds)
        let attentionBlock = attentionHeight > 0 ? attentionHeight + paneGap : 0
        switch posture {
        case .continuous:
            return nil

        case .sideBySide(let leading, let trailing):
            let waterBottom = bounds.height * (1 - sandFraction)
            let leadingInner = leading.insetBy(dx: edgePadding, dy: 0)
            let trailingInner = trailing.insetBy(dx: edgePadding, dy: 0)
            // No Timeline shares the leading pane, so the roster may use its
            // full height, sand bed included.
            let sessionsTop = edgePadding + attentionBlock
            let sessions = CGRect(
                x: leadingInner.minX, y: sessionsTop,
                width: leadingInner.width,
                height: max(0, bounds.height - edgePadding - sessionsTop))
            let system = CGRect(
                x: trailingInner.minX, y: edgePadding,
                width: trailingInner.width,
                height: max(0, waterBottom - paneGap - edgePadding))
            return DashboardFoldFrames(
                posture: posture,
                terrarium: full,
                deck: nil,
                attention: CGRect(x: leadingInner.minX, y: edgePadding, width: leadingInner.width, height: 0),
                sessions: showsSessions ? sessions : nil,
                system: showsSystem ? system : nil,
                timeline: CGRect(x: trailing.minX, y: waterBottom, width: trailing.width, height: bounds.height - waterBottom),
                notice: CGRect(x: trailing.minX, y: 0, width: trailing.width, height: waterBottom))

        case .stacked(let upper, let lower):
            let inner = lower.insetBy(dx: edgePadding, dy: edgePadding)
            let hasRail = showsSessions || showsSystem
            // The rail keeps the session panel's readable width; the centre
            // column gets the rest for the question and the Timeline.
            let railWidth = hasRail ? min(max(220, inner.width * 0.38), 300) : 0
            let rail = CGRect(x: inner.minX, y: inner.minY, width: railWidth, height: inner.height)
            let centreX = hasRail ? rail.maxX + paneGap : inner.minX
            let centre = CGRect(x: centreX, y: inner.minY, width: inner.maxX - centreX, height: inner.height)
            let timelineTop = centre.minY + attentionBlock
            // Size the habitat so its waterline sits just above the crease and
            // the remaining sand runs on under the control deck.
            let waterHeight = upper.height * (1 - stackedUpperSandShare)
            let habitatHeight = min(bounds.height - upper.minY,
                                    max(upper.height, waterHeight / max(0.01, 1 - sandFraction)))
            return DashboardFoldFrames(
                posture: posture,
                terrarium: CGRect(x: upper.minX, y: upper.minY, width: upper.width, height: habitatHeight),
                deck: lower,
                attention: CGRect(x: centre.minX, y: centre.minY, width: centre.width, height: 0),
                sessions: showsSessions ? rail : nil,
                system: showsSystem ? rail : nil,
                timeline: CGRect(x: centre.minX, y: timelineTop, width: centre.width,
                                 height: max(0, centre.maxY - timelineTop)),
                notice: upper)
        }
    }
}

/// Reads the display division from a Dashboard `GeometryProxy`.
///
/// `ReservedRegion` ships in the iOS 27.1 SDK. The compiler check stands in for
/// an SDK check (Swift has none): an older Xcode on CI compiles the
/// continuous-only fallback instead of failing on the missing symbol. At run
/// time anything before iOS 27.1, every non-foldable device and the folded
/// Duo's cover display report no division and keep the continuous layout.
enum DashboardFoldGeometry {
    @MainActor
    static func posture(of geo: GeometryProxy) -> DashboardFoldPosture {
        #if os(iOS) && compiler(>=6.4.1)
        if #available(iOS 27.1, *) {
            let divisions = geo.reservedRegions(kind: .division)
                .filter(\.isActive)
                .map(\.frame)
            return DashboardFoldLayout.posture(bounds: geo.size, divisions: divisions)
        }
        #endif
        return .continuous
    }
}
