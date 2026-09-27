// StatusBadge.swift — State indicator badge

import SwiftUI

struct StatusBadge: View {
    let state: AgentConnectionState

    // Session state palette — DESIGN.md §2.7 (generated from shared/src).
    private var color: Color { StateColors.color(for: state) }

    var body: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(color)
                .frame(width: 8, height: 8)
            Text(state.displayLabel)
                .font(.caption.bold())
                .foregroundStyle(color)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(color.opacity(0.15), in: Capsule())
    }
}
