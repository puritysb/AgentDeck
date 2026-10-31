import SwiftUI

/// A water resident, independent of the coding-session roster and HUD panels.
struct DotHabitatView: View {
    let snapshot: DotSurfaceSnapshot
    var animationPaused = false
    var labelsVisible = true
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { clock in
            let now = Int(clock.date.timeIntervalSince1970 * 1000)
            if snapshot.inhabitsHabitat(at: now) {
                TimelineView(.animation(minimumInterval: 1.0 / 30,
                                        paused: animationPaused || scenePhase != .active || reduceMotion || snapshot.phase(at: now) != 2)) { frame in
                    GeometryReader { geo in
                        let offset = DotHabitatRules.offset(seconds: frame.date.timeIntervalSinceReferenceDate,
                            working: snapshot.phase(at: now) == 2, motion: !reduceMotion && !animationPaused && scenePhase == .active)
                        let side = min(DotHabitatRules.maxSize, max(DotHabitatRules.minSize,
                            geo.size.height * DotHabitatRules.sizeFraction))
                        DotSurfaceView(snapshot: snapshot, style: .habitat, showsHabitatLabel: labelsVisible)
                            .frame(width: side, height: side + (labelsVisible ? 16 : 0))
                            .position(x: geo.size.width * (DotHabitatRules.homeX + offset.x * DotHabitatRules.travelX),
                                      y: geo.size.height * (DotHabitatRules.homeY + offset.y * DotHabitatRules.travelY))
                    }
                }
            }
        }
    }
}
