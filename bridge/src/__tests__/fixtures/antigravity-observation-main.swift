import Foundation
struct Vector: Decodable {
    let conversationId: String; let raw: String; let modifiedAtMs: Int64; let nowMs: Int64
}
@main struct AntigravityFixture {
    static func main() throws {
        let input = FileHandle.standardInput.readDataToEndOfFile()
        let output: Data
        if CommandLine.arguments.count > 2 {
            let scan = AntigravitySourceReader.scan(root: URL(fileURLWithPath: CommandLine.arguments[1]), nowMs: Int64(CommandLine.arguments[2])!)
            output = try JSONEncoder().encode(scan)
        } else {
            let vectors = try JSONDecoder().decode([Vector].self, from: input)
            output = try JSONEncoder().encode(vectors.map { AntigravityTranscript.observe(id: $0.conversationId, raw: $0.raw, modifiedAtMs: $0.modifiedAtMs, nowMs: $0.nowMs) })
        }
        print(String(decoding: output, as: UTF8.self))
    }
}
