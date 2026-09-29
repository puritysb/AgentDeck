// GaugeBar.swift — Rate limit gauge display

import SwiftUI

extension UsageSeverity {
    static func color(_ used: Double, onPaper: Bool = false) -> Color {
        Color(rgb: colorHex(used, onPaper: onPaper))
    }
}

struct GaugeBar: View {
    let label: String
    let percent: Double
    var resetTime: String? = nil

    @Environment(\.colorScheme) private var colorScheme

    private var barColor: Color {
        UsageSeverity.color(percent, onPaper: colorScheme == .light)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                Text(label)
                    .font(.caption2.bold())
                    .foregroundStyle(.secondary)
                Text("\(Int(percent))%")
                    .font(.caption2)
                    .foregroundStyle(barColor)
                if let reset = resetTime {
                    Text(reset)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }

            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(Color.white.opacity(0.1))
                        .frame(height: 4)

                    RoundedRectangle(cornerRadius: 2)
                        .fill(barColor)
                        .frame(width: geo.size.width * min(percent / 100, 1), height: 4)
                }
            }
            .frame(height: 4)
        }
        .frame(minWidth: 80)
    }
}
