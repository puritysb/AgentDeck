import Foundation
import CoreFoundation

/// Mirror of shared/src/opencode-question.ts; shared vectors pin both readers.
struct OpenCodeDeviceQuestion: Sendable, Equatable {
    struct Option: Sendable, Equatable {
        let label: String
        let description: String?
        let index: Int
    }
    let question: String
    let options: [Option]
    let replyable: Bool

    static func parse(_ value: Any?) -> Self? {
        guard let groups = value as? [[String: Any]], !groups.isEmpty,
              groups.count <= ObservedAgentRules.openCodeQuestionMaxQuestions else { return nil }
        var first: Self?
        for group in groups {
            if let multiple = group["multiple"], CFGetTypeID(multiple as CFTypeRef) != CFBooleanGetTypeID() { return nil }
            let text = ((group["question"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
                ? group["question"] as? String : group["header"] as? String) ?? ""
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  text.utf16.count <= ObservedAgentRules.openCodeQuestionMaxText,
                  let rawOptions = group["options"] as? [[String: Any]],
                  rawOptions.count <= ObservedAgentRules.openCodeQuestionMaxOptions else { return nil }
            var options: [Option] = []
            for (index, raw) in rawOptions.enumerated() {
                guard let label = raw["label"] as? String,
                      !label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                      label.utf16.count <= ObservedAgentRules.openCodeQuestionMaxLabel else { return nil }
                let detail = (raw["description"] as? String).map {
                    String(decoding: $0.utf16.prefix(ObservedAgentRules.openCodeQuestionMaxText), as: UTF16.self)
                }
                options.append(Option(label: label, description: detail, index: index))
            }
            if first == nil {
                first = Self(question: text, options: options, replyable: groups.count == 1
                    && (group["multiple"] as? Bool) != true && !options.isEmpty
                    && Set(options.map(\.label)).count == options.count)
            }
        }
        return first
    }
}
