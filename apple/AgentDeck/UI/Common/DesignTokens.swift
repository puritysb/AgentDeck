// DesignTokens.swift — Swift mirror of design/tokens.css.
// See DESIGN.md for the spec. The CSS file remains the source of truth;
// keep this file in sync when tokens change.

import SwiftUI

private func tokenColor(_ hex: String) -> Color {
    var s = hex
    if s.hasPrefix("#") { s.removeFirst() }
    guard s.count == 6, let v = UInt32(s, radix: 16) else {
        return Color(red: 1.0, green: 0.0, blue: 1.0)
    }
    let r = Double((v >> 16) & 0xff) / 255.0
    let g = Double((v >> 8) & 0xff) / 255.0
    let b = Double(v & 0xff) / 255.0
    return Color(red: r, green: g, blue: b)
}

enum DesignTokens {

    // MARK: - Tide (sand / paper)

    enum Tide {
        static let s50  = tokenColor("#f5f3ec")
        static let s100 = tokenColor("#ebe6d6")
        static let s200 = tokenColor("#d8cfb6")
        static let s300 = tokenColor("#a8b09a")
    }

    // MARK: - Ink (deep aquarium)

    enum Ink {
        static let s900 = tokenColor("#0e1f1f")
        static let s800 = tokenColor("#15302f")
        static let s700 = tokenColor("#1f4544")
        static let s500 = tokenColor("#426664")
        static let s300 = tokenColor("#7c9694")
    }

    // MARK: - Kelp (App Store / running / OK)

    enum Kelp {
        static let s700 = tokenColor("#1f6157")
        static let s500 = tokenColor("#2f8a7c")
        static let s300 = tokenColor("#6fb6a8")
    }

    // MARK: - Coral (Developer / build)

    enum Coral {
        static let s500 = tokenColor("#c0573a")
        static let s700 = tokenColor("#8c3a23")
    }

    // MARK: - Amber (attention only — only color allowed to pulse)

    enum Amber {
        static let s500 = tokenColor("#c8923a")
    }

    // MARK: - Marketing status semantics (DESIGN.md §2.7)

    enum Status {
        static let idle       = Ink.s300
        static let processing = Kelp.s500
        static let awaiting   = Amber.s500
        static let error      = Coral.s500
    }

    // MARK: - Product UI palette (menubar / e-ink / hardware / TTY)
    // Brighter signal colors. DESIGN.md §2.6: marketing surfaces must NEVER use these.

    enum UI {
        static let ok           = tokenColor("#52D988")
        static let attn         = tokenColor("#FFA93D")
        static let error        = tokenColor("#FF6B6B")
        static let cyan         = tokenColor("#3ED6E8")
        static let idle         = tokenColor("#9a9aa2")
        static let idleDark     = tokenColor("#7a8a9c")
        static let popupBgDark  = tokenColor("#0a1a2a")
        static let popupBgDeep  = tokenColor("#061018")
        static let popupBgMid   = tokenColor("#0a1520")
        static let popupBgLight = tokenColor("#f6f3ee")
        static let ttyBg        = tokenColor("#0c0d10")
        static let ttyBgMid     = tokenColor("#141820")
        static let ttyText      = tokenColor("#c8d0d8")
        static let ttyDim       = tokenColor("#7a8493")
        static let ttyFaint     = tokenColor("#4a5060")
    }

    // MARK: - Agent brand marks
    // The only saturated reds/blues allowed in the system. Sourced from upstream
    // brand SVGs in design/brand/ — do not redraw or restyle.

    enum Brand {
        static let claudeCode = tokenColor("#C07058")
        static let codex      = tokenColor("#6166E0")
        static let openclaw   = tokenColor("#FF4D4D")
        static let opencode   = tokenColor("#3a3a3a")
        static let antigravity = tokenColor("#5F6368")
        static let kiro       = tokenColor("#7C3AED")
    }

    // MARK: - Type stack

    enum Font {
        static let sans = "IBM Plex Sans"
        static let sansKR = "IBM Plex Sans KR"
        static let sansJP = "IBM Plex Sans JP"
        static let mono = "JetBrains Mono"
        static let monoFallback = "IBM Plex Mono"
    }

    // MARK: - Type scale (DESIGN.md §3.2)

    enum FontSize {
        static let h2: CGFloat         = 44
        static let h3: CGFloat         = 26
        static let h3Lg: CGFloat       = 32
        static let cardTitle: CGFloat  = 19
        static let bodyLg: CGFloat     = 19
        static let body: CGFloat       = 17
        static let lede: CGFloat       = 18
        static let small: CGFloat      = 14.5
        static let caption: CGFloat    = 13
        static let kicker: CGFloat     = 12
        static let monoBadge: CGFloat  = 11.5
    }

    enum Tracking {
        static let hero: CGFloat       = -0.035
        static let editorial: CGFloat  = -0.04
        static let h2: CGFloat         = -0.02
        static let h3: CGFloat         = -0.015
        static let card: CGFloat       = -0.01
        static let kicker: CGFloat     = 0.18
        static let badge: CGFloat      = 0.16
        static let chip: CGFloat       = 0.08
    }

    // MARK: - Spacing scale (4px base)

    enum Spacing {
        static let s1: CGFloat  = 4
        static let s2: CGFloat  = 8
        static let s3: CGFloat  = 12
        static let s4: CGFloat  = 16
        static let s5: CGFloat  = 20
        static let s6: CGFloat  = 24
        static let s8: CGFloat  = 32
        static let s10: CGFloat = 40
        static let s12: CGFloat = 48
        static let s14: CGFloat = 56
        static let s16: CGFloat = 64
        static let s20: CGFloat = 80
        static let s24: CGFloat = 96
        static let s30: CGFloat = 120
    }

    // MARK: - Radii

    enum Radius {
        static let sm: CGFloat   = 4
        static let md: CGFloat   = 8
        static let lg: CGFloat   = 10
        static let xl: CGFloat   = 12
        static let xxl: CGFloat  = 14
        static let xxxl: CGFloat = 16
        static let xxxxl: CGFloat = 18
        static let pill: CGFloat = 999
    }

    // MARK: - Layout

    enum Layout {
        static let containerMax: CGFloat = 1240
        static let containerPad: CGFloat = 32
        static let sectionY: CGFloat     = 96
    }

    // MARK: - Motion (durations in milliseconds — divide by 1000 for seconds)

    enum Motion {
        static let fast: Int   = 120
        static let base: Int   = 200
        static let slow: Int   = 320
        static let pulse: Int  = 1100
        static let wiggle: Int = 700
    }
}
