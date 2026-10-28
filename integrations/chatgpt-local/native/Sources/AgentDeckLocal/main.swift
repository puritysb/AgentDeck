import Foundation
import Darwin
import NativeClientCore

signal(SIGPIPE, SIG_IGN)
func run() throws -> Int32 {
    var args = Array(CommandLine.arguments.dropFirst())
    guard !args.isEmpty else { throw ClientFailure.invalidInput }
    let command = args.removeFirst()
    if command == "--help" || command == "help" {
        print("agentdeck-local authorize|call|serve|disconnect [--account NAME] [--port PORT] [--request-id ID]\ncall reads one newline-terminated JSON {tool,arguments}; serve uses MCP JSON lines. Authorize separately and approve in AgentDeck. This standalone preview helper is not the App Store application.")
        return 0
    }
    guard ["authorize", "call", "serve", "disconnect"].contains(command) else { throw ClientFailure.invalidInput }
    var options: [String: String] = [:]
    while !args.isEmpty {
        let key = args.removeFirst()
        guard ["--account", "--port", "--request-id"].contains(key), options[key] == nil, !args.isEmpty else { throw ClientFailure.invalidInput }
        options[key] = args.removeFirst()
    }
    let port: Int?
    if let raw = options["--port"] { guard let value = Int(raw) else { throw ClientFailure.invalidInput }; port = value } else { port = nil }
    let endpoint = try Endpoint(port: port), account = options["--account"] ?? "default"
    let requestID = options["--request-id"]
    if command == "call" && requestID == nil { throw ClientFailure.invalidInput }
    if let requestID {
        guard requestID.range(of: "^[A-Za-z0-9_.:-]{1,128}$", options: .regularExpression) != nil,
              ["call", "serve"].contains(command) else { throw ClientFailure.invalidInput }
    }
    let directory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/AgentDeckLocalClient", isDirectory: true)
    let vault = try KeychainVault(account: account, endpoint: endpoint)
    let client = LocalClient(endpoint: endpoint, vault: vault, acquireLock: { try PrivateLock(directory: directory, name: "\(account)-\(endpoint.port)") })
    switch command {
    case "authorize":
        try client.authorize { try Framing.write($0, fd: STDERR_FILENO) }
        try Framing.write(["authorized": true])
    case "disconnect":
        try client.disconnect(); try Framing.write(["disconnected": true])
    case "call":
        let input = try Contract.object(Framing.readSingle())
        guard Set(input.keys) == Set(["tool", "arguments"]), let tool = input["tool"] as? String,
              let arguments = input["arguments"] as? [String: Any] else { throw ClientFailure.invalidInput }
        let result = try client.call(tool: tool, arguments: arguments, requestID: requestID)
        try Framing.write(result)
        if result["isError"] as? Bool == true { return 1 }
    case "serve":
        let frontend = MCPFrontend(client: client, requestID: requestID)
        try Framing.readFrames { frame in
            let response: [String: Any]?
            do { response = frontend.handle(try Contract.object(frame)) }
            catch { response = ["jsonrpc": "2.0", "id": NSNull(), "error": ["code": -32700, "message": "Invalid JSON request"]] }
            if let response { try Framing.write(response) }
        }
    default: throw ClientFailure.invalidInput
    }
    return 0
}
do { exit(try run()) }
catch let failure as ClientFailure { try? Framing.write(["error": failure.description], fd: STDERR_FILENO); exit(1) }
catch { try? Framing.write(["error": "Local client failed; no credential was printed. Reauthorize if a refresh was interrupted."], fd: STDERR_FILENO); exit(1) }
