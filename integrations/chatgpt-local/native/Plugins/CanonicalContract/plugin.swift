import PackagePlugin
@main struct CanonicalContract: BuildToolPlugin {
    func createBuildCommands(context: PluginContext, target: Target) throws -> [Command] {
        let root = context.package.directoryURL.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let inputs = ["apple/AgentDeck/Daemon/Dot/DotRules.generated.swift", "apple/AgentDeck/Resources/dot-mcp-contract.json", "services/dot-relay/src/server.ts"].map { root.appending(path: $0) }
        let output = context.pluginWorkDirectoryURL.appending(path: "Canonical.generated.swift")
        return [.buildCommand(displayName: "Read canonical AgentDeck MCP contract", executable: try context.tool(named: "ContractGenerator").url,
            arguments: inputs.map(\.path) + [output.path], inputFiles: inputs, outputFiles: [output])]
    }
}
