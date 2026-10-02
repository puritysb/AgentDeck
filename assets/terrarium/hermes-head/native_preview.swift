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
  let view_ = CommandLine.arguments.count > 4 ? CommandLine.arguments[4] : "full"
  switch view_ {
  case "face": camera.camera.fieldOfViewInDegrees = 22; camera.look(at: [0, 0.20, 0], from: [0, 0.22, 1.6], relativeTo: nil)
  case "tq": camera.camera.fieldOfViewInDegrees = 22; camera.look(at: [0, 0.20, 0], from: [0.85, 0.32, 1.36], relativeTo: nil)
  case "master": camera.camera.fieldOfViewInDegrees = 15; camera.look(at: [0, 0.195, 0], from: [3.0 * sin(0.5585), 0.195 + 3.0 * sin(0.0698), 3.0 * cos(0.5585)], relativeTo: nil)
  case "side": camera.camera.fieldOfViewInDegrees = 22; camera.look(at: [0, 0.20, 0], from: [1.6, 0.22, 0], relativeTo: nil)
  case "profile": camera.camera.fieldOfViewInDegrees = 1.25; camera.look(at: [0.0, 0.215, -0.05], from: [40.0, 0.215, -0.05], relativeTo: nil)
  case "frontfar": camera.camera.fieldOfViewInDegrees = 1.25; camera.look(at: [0, 0.215, 0], from: [0, 0.215, 40.0], relativeTo: nil)
  default: camera.look(at: [0, 0.035, 0], from: [0.9, 0.1, 2], relativeTo: nil)
  }
  anchor.addChild(camera)
  // The app's lights (AquariumPreview.swift): sun 5000 from (-4, 8, 5), fill 900
  // from (4, 4, -4), relative to the resident. Judge the model under these.
  for (position, target, intensity) in [(SIMD3<Float>(-4, 8, 5), SIMD3<Float>(0, 0, 0), Float(5000)),
                                        (SIMD3<Float>(4, 4, -4), SIMD3<Float>(0, 1, 0), Float(900))] {
   let light = DirectionalLight()
   light.light.intensity = intensity
   light.look(at: target, from: position, relativeTo: nil)
   anchor.addChild(light)
  }
  view.scene.addAnchor(anchor)
  // Mirror HermesMermaid.Rig: closed lids and the mouth opening start hidden.
  for name in ["mouth_open", "hermes_lid_left", "hermes_lid_right"] { root.findEntity(named: name)?.isEnabled = false }
  if CommandLine.arguments.count > 3, CommandLine.arguments[3] == "blink" {
   for side in ["left", "right"] {
    root.findEntity(named: "hermes_eye_" + side)?.isEnabled = false
    root.findEntity(named: "hermes_lid_" + side)?.isEnabled = true
   }
  }
  if CommandLine.arguments.count > 3, CommandLine.arguments[3] != "open" {
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
