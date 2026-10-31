#if os(macOS)
import Foundation
import JavaScriptCore

/// A fixed, generated application renderer evaluated by the OS framework. It
/// exposes no native callbacks, file/network APIs or remote code-loading path.
/// This synchronous instance is owned by PixooModule's actor, never the UI.
final class PixooBakedRenderer {
    enum Failure: Error { case unavailable, invalid, limit }
    private let source: String
    private var renderContext: JSContext?
    private var activityContext: JSContext?
    private var cached: (key: Data, frames: [Data])?
    init(source: String? = nil) throws {
        if let source { self.source = source; return }
        guard let url = Bundle.main.url(forResource: "pixoo-baked.generated", withExtension: "js") else { throw Failure.unavailable }
        self.source = try String(contentsOf: url, encoding: .utf8)
    }
    func clear() { cached = nil; renderContext = nil; activityContext = nil }
    func isActive(state: [String: Any]?, sessions: [[String: Any]], timeline: [[String: Any]], nowMs: Double) -> Bool {
        let input: [String: Any] = ["state": state ?? NSNull(), "sessions": sessions, "timeline": timeline, "nowMs": nowMs]
        guard JSONSerialization.isValidJSONObject(input), let data = try? JSONSerialization.data(withJSONObject: input),
              data.count <= PixooLoopPolicy.maxInputBytes else { return false }
        if activityContext == nil { activityContext = JSContext(); activityContext?.evaluateScript(source) }
        guard let context = activityContext else { return false }
        context.exception = nil
        return context.objectForKeyedSubscript("agentdeckPixooActive")?.call(withArguments: [String(decoding: data, as: UTF8.self)])?.toBool() ?? false
    }
    func signature(state: [String: Any]?, usage: [String: Any]?, sessions: [[String: Any]], timeline: [[String: Any]], nowMs: Double) -> String? {
        let input: [String: Any] = ["state": state ?? NSNull(), "usage": usage ?? NSNull(), "sessions": sessions, "timeline": timeline, "nowMs": nowMs]
        guard nowMs.isFinite, sessions.count <= PixooLoopPolicy.maxSessions, JSONSerialization.isValidJSONObject(input),
              let data = try? JSONSerialization.data(withJSONObject: input), data.count <= PixooLoopPolicy.maxInputBytes else { return nil }
        if activityContext == nil { activityContext = JSContext(); activityContext?.evaluateScript(source) }
        guard let context = activityContext else { return nil }; context.exception = nil
        let result = context.objectForKeyedSubscript("agentdeckPixooSignature")?.call(withArguments: [String(decoding: data, as: UTF8.self)])?.toString()
        return context.exception == nil ? result : nil
    }
    func render(state: [String: Any]?, usage: [String: Any]?, sessions: [[String: Any]]?,
                subagents: [String: Any]? = nil, timeline: [[String: Any]] = [], nowMs: Double, loop: Bool = true) throws -> [Data] {
        guard nowMs.isFinite, (sessions?.count ?? 0) <= PixooLoopPolicy.maxSessions else { throw Failure.limit }
        var input: [String: Any] = ["nowMs": nowMs, "loop": loop, "state": state ?? NSNull(), "usage": usage ?? NSNull(),
                                    "sessions": sessions ?? NSNull(), "timeline": timeline]
        if let subagents { input["subagents"] = subagents }
        guard JSONSerialization.isValidJSONObject(input) else { throw Failure.invalid }
        let json = try JSONSerialization.data(withJSONObject: input, options: [.sortedKeys])
        guard json.count <= PixooLoopPolicy.maxInputBytes else { throw Failure.limit }
        input["nowMs"] = floor(nowMs / Double(PixooLoopPolicy.loopRefreshMs))
        let key = try JSONSerialization.data(withJSONObject: input, options: [.sortedKeys])
        if cached?.key != key {
            // One isolated context preserves canonical simulation between bakes,
            // unaffected by preview rendering. Only signed fixed pixel code is
            // evaluated; the input is JSON data, never a script.
            let frames: [Data] = try autoreleasepool {
            if renderContext == nil { renderContext = JSContext(); renderContext?.evaluateScript(source) }
            guard let context = renderContext, context.exception == nil else { throw Failure.unavailable }
            guard
                  let function = context.objectForKeyedSubscript("agentdeckPixooBake"),
                  let result = function.call(withArguments: [String(decoding: json, as: UTF8.self)])?.toString(),
                  context.exception == nil, let bytes = result.data(using: .utf8),
                  let encoded = try? JSONDecoder().decode([String].self, from: bytes),
                  encoded.count == (loop ? PixooLoopPolicy.uniqueFrames * 2 - 2 : 1) else { throw Failure.invalid }
            let frames = encoded.compactMap { Data(base64Encoded: $0) }
            guard frames.count == encoded.count, frames.allSatisfy({ $0.count == PixooLoopPolicy.frameBytes }) else { throw Failure.invalid }
            return frames
            }
            cached = (key, frames)
        }
        return cached!.frames
    }
}
#endif
