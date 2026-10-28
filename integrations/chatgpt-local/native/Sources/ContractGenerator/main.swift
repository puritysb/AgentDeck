import Foundation
let args = Array(CommandLine.arguments.dropFirst())
guard args.count == 4 else { fatalError("Expected rules, contract, protocol source and output") }
let rules = try String(contentsOfFile: args[0], encoding: .utf8)
let contract = try Data(contentsOf: URL(fileURLWithPath: args[1]))
let source = try String(contentsOfFile: args[2], encoding: .utf8)
let regex = try NSRegularExpression(pattern: "const TOOL_VERSION = '([^']+)'")
guard let match = regex.firstMatch(in: source, range: NSRange(source.startIndex..., in: source)), let range = Range(match.range(at: 1), in: source) else { fatalError("Missing canonical tools protocol version") }
let version = String(source[range])
guard version.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", options: .regularExpression) != nil else { fatalError("Invalid protocol version") }
let result = "import Foundation\n" + rules + "\nenum Canonical {\n static let protocolVersion = \"\(version)\"\n static let contractData = Data(base64Encoded: \"\(contract.base64EncodedString())\")!\n}\n"
try result.write(toFile: args[3], atomically: true, encoding: .utf8)
