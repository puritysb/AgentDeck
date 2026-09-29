// TerrariumView.swift — 60fps animated aquarium using TimelineView + Canvas

import SwiftUI

struct TerrariumView: View {
    let terrariumState: TerrariumState
    var includeHabitat: Bool = true

    /// Optional tap handler: receives the session ID of the tapped creature.
    /// Works on macOS (click) and iOS/iPadOS (touch) — both use the same
    /// overlay + hit-test math because SwiftUI normalizes `onTapGesture` to
    /// the gesture recognizer that matches the platform.
    var onCreatureTapped: ((String) -> Void)?

    /// Optional tap handler invoked when a tap lands on empty water — i.e.
    /// `creatureAtPoint` returned nil. Mirrors the ESP32 firmware's
    /// "tap aquarium background to hide HUD" pattern so the iOS dashboard
    /// can fade SessionListPanel + TopologyRail for an unobstructed view.
    /// Cross-platform safe; the call site decides whether to wire it up.
    var onBackgroundTapped: (() -> Void)?

    @State private var renderer = TerrariumRenderer()

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 60)) { timeline in
            Canvas { context, size in
                let dt = renderer.deltaTime(now: timeline.date)

                renderer.update(dt: dt, state: terrariumState)
                renderer.draw(context: &context, size: size, includeHabitat: includeHabitat)
            }
        }
        .overlay {
            if onCreatureTapped != nil || onBackgroundTapped != nil {
                GeometryReader { geo in
                    Color.clear
                        .contentShape(Rectangle())
                        .onTapGesture { location in
                            let nx = Float(location.x / geo.size.width)
                            let ny = Float(location.y / geo.size.height)
                            if let sessionId = renderer.creatureAtPoint(nx: nx, ny: ny) {
                                onCreatureTapped?(sessionId)
                            } else {
                                onBackgroundTapped?()
                            }
                        }
                }
            }
        }
    }
}
