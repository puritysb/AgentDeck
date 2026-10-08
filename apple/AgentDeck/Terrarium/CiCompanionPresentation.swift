import ImageIO
import SwiftUI

/// Observed CI attaches to an actual session. No helper is a new resident or agent.
enum CiCompanionPresentation {
  nonisolated(unsafe) static let sprite: CGImage? = {
    guard let url = Bundle.main.url(forResource: "ci-companion", withExtension: "png"),
      let source = CGImageSourceCreateWithURL(url as CFURL, nil)
    else { return nil }
    return CGImageSourceCreateImageAtIndex(source, 0, nil)
  }()

  static func label(_ wait: CiWaitStatus) -> String {
    let phase =
      ["queued", "running", "passed", "failed"].contains(wait.phase)
      ? wait.phase.uppercased() : "UNKNOWN"
    return "CI \(phase)" + (wait.pr.map { " #\($0)" } ?? "")
      + (wait.checks.map { " · \($0.passed)/\($0.total)" } ?? "")
  }
  static func badge(_ wait: CiWaitStatus) -> String {
    switch wait.phase {
    case "running": wait.checks.map { "\($0.passed)/\($0.total)" } ?? "CI running"
    case "queued": "CI queued"
    case "passed": "CI ✓"
    case "failed": "CI !"
    default: "CI ?"
    }
  }
  static func color(_ wait: CiWaitStatus?) -> Color {
    switch wait?.phase {
    case "queued", "running": DesignTokens.Session.working
    case "passed": DesignTokens.UI.ok
    case "failed": DesignTokens.Session.error
    default: DesignTokens.Session.idle
    }
  }
  static func active(_ wait: CiWaitStatus?) -> Bool {
    guard let wait else { return false }
    return wait.agentWaiting && wait.phase != "passed" && wait.phase != "failed"
  }
  static func seed(_ id: String) -> Float {
    var hash = TerrariumRules.ciCompanionSeedOffset
    for byte in id.utf8 { hash = (hash ^ UInt32(byte)) &* TerrariumRules.ciCompanionSeedPrime }
    return Float(hash % TerrariumRules.ciCompanionSeedModulus)
      / Float(TerrariumRules.ciCompanionSeedModulus)
  }
  static func speed(_ wait: CiWaitStatus) -> Float {
    let ratio =
      wait.phase == "running"
      ? Float(1)
      : wait.phase == "queued"
        ? TerrariumRules.ciCompanionQueuedSpeed : TerrariumRules.ciCompanionUnknownSpeed
    return TerrariumRules.ciCompanionRadiansPerSecond * ratio
  }
  static func position(center: SIMD2<Float>, angle: Float, size: CGSize) -> SIMD2<Float> {
    let short = Float(min(size.width, size.height))
    return [
      max(
        TerrariumRules.ciCompanionEdgeInset,
        min(
          1 - TerrariumRules.ciCompanionEdgeInset,
          center.x + cos(angle) * TerrariumRules.ciCompanionOrbitRadiusX * short / Float(size.width)
        )),
      max(
        TerrariumRules.ciCompanionEdgeInset,
        min(
          1 - TerrariumRules.ciCompanionEdgeInset,
          center.y + sin(angle) * TerrariumRules.ciCompanionOrbitRadiusY * short
            / Float(size.height))),
    ]
  }
  static func draw(
    context: inout GraphicsContext, size: CGSize, center: SIMD2<Float>, position: SIMD2<Float>,
    wait: CiWaitStatus
  ) {
    let short = min(size.width, size.height)
    let width = short * CGFloat(TerrariumRules.ciCompanionSizeFrac)
    let x = CGFloat(position.x) * size.width
    let y = CGFloat(position.y) * size.height
    var line = Path()
    line.move(to: CGPoint(x: CGFloat(center.x) * size.width, y: CGFloat(center.y) * size.height))
    line.addLine(to: CGPoint(x: x, y: y))
    context.stroke(line, with: .color(color(wait).opacity(0.35)), lineWidth: 1)
    if let sprite {
      context.draw(
        Image(decorative: sprite, scale: 1),
        in: CGRect(x: x - width / 2, y: y - width / 2, width: width, height: width))
    }
    context.draw(
      Text(badge(wait)).font(.custom("IBMPlexSans", size: 12)).foregroundColor(color(wait)),
      at: CGPoint(x: x, y: y + width / 2 + 8))
  }
}

struct CiCompanionMotion {
  var angle: Float
  private var key: String?
  private(set) var resultDeadline: TimeInterval?

  init(id: String) { angle = CiCompanionPresentation.seed(id) * 2 * Float.pi }

  mutating func update(
    _ wait: CiWaitStatus, dt: Float, now: TimeInterval = ProcessInfo.processInfo.systemUptime
  ) {
    let next = "\(wait.openedAt):\(wait.phase)"
    if next != key && (wait.phase == "passed" || wait.phase == "failed") {
      if key == nil { angle = TerrariumRules.ciCompanionStaticAngle }
      resultDeadline = now + Double(TerrariumRules.ciCompanionResultSeconds)
    } else if wait.phase != "passed" && wait.phase != "failed" {
      resultDeadline = nil
    }
    key = next
    if CiCompanionPresentation.active(wait) { angle += dt * CiCompanionPresentation.speed(wait) }
  }

  func visible(_ wait: CiWaitStatus, now: TimeInterval = ProcessInfo.processInfo.systemUptime)
    -> Bool
  {
    CiCompanionPresentation.active(wait) || ((wait.phase == "passed" || wait.phase == "failed") && (resultDeadline.map { now < $0 } ?? false))
  }
}
