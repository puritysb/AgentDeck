// Standalone test harness; never bundled into the application.
import Foundation
@main struct MatrixParity {
    static func main() throws {
        let input = FileHandle.standardInput.readDataToEndOfFile()
        let steps = try JSONSerialization.jsonObject(with: input) as! [[String: Any]]
        var expression = MatrixExpression()
        var frames: [[String: Any]] = []
        for step in steps {
            let now = step["now"] as! Double
            if let event = step["event"] as? [String: Any] { expression.ingest(event, now: now) }
            let scene = expression.scene(now: now)
            frames.append(["kind": scene.kind, "count": scene.count, "glyph": scene.glyph, "faceKind": scene.face, "pips": scene.pips,
                "counts": scene.counts, "face": expression.render(size: 11, now: now).base64EncodedString(),
                "world": expression.render(size: 32, now: now).base64EncodedString()])
        }
        FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: frames))
    }
}
