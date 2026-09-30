// Standalone RealityKit USDZ review. No AgentDeck app, daemon, or screenshots of the user desktop.
// Compile with xcrun swiftc -parse-as-library; arguments: model.usdz output.png [blink|half].
import AppKit
import RealityKit
import Foundation
@main struct Preview {
 @MainActor static func main() async throws {
  let app = NSApplication.shared
  app.setActivationPolicy(.accessory)
  let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 720, height: 720), styleMask: [.borderless], backing: .buffered, defer: false)
  let view = ARView(frame: NSRect(x: 0, y: 0, width: 720, height: 720))
  window.contentView = view
  window.setFrameOrigin(NSPoint(x: -2000, y: -2000))
  window.orderFront(nil)
  view.environment.background = .color(NSColor(calibratedRed: 0.035, green: 0.055, blue: 0.065, alpha: 1))
  let root = try await Entity(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
  let anchor = AnchorEntity(world: .zero)
  anchor.addChild(root)
  let camera = PerspectiveCamera()
  camera.camera.fieldOfViewInDegrees = 29
  camera.look(at: [0, 0.035, 0], from: [0.9, 0.1, 2], relativeTo: nil)
  anchor.addChild(camera)
  for (position,intensity) in [(SIMD3<Float>(1.5,2,3),Float(1500)),(SIMD3<Float>(-2,1,1),Float(900))] {
   let light = DirectionalLight()
   light.light.intensity = intensity
   light.look(at: .zero, from: position, relativeTo: nil)
   anchor.addChild(light)
  }
  view.scene.addAnchor(anchor)
  if CommandLine.arguments.count > 3 {
   let fraction: Float = CommandLine.arguments[3] == "half" ? 0.5 : 1
   func blink(_ node: Entity) {
    if let model = node as? ModelEntity, let mesh = model.model?.mesh {
     var c = BlendShapeWeightsComponent(weightsMapping: BlendShapeWeightsMapping(meshResource: mesh))
     for index in 0..<c.weightSet.count {
      var d = c.weightSet[index]
      d.weights = BlendShapeWeights(d.weightNames.map {
       if $0 == "blink_left" || $0 == "blink_right" { return fraction }
       if $0 == "blink_mid_left" || $0 == "blink_mid_right" { return 4 * fraction * (1 - fraction) }
       return Float(0)
      })
      c.weightSet[index] = d
     }
     if c.weightSet.count > 0 { model.components.set(c) }
    }
    for child in node.children { blink(child) }
   }
   blink(root)
  }
  try await Task.sleep(for: .seconds(2))
  let image: NSImage? = await withCheckedContinuation { continuation in
   view.snapshot(saveToHDR: false) { image in continuation.resume(returning: image) }
  }
  guard let data = image?.tiffRepresentation, let bitmap = NSBitmapImageRep(data: data), let png = bitmap.representation(using: .png, properties: [:]) else { throw CocoaError(.fileWriteUnknown) }
  try png.write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
  print("NATIVE_RENDER", CommandLine.arguments[2])
  window.orderOut(nil)
 }
}
