// swift-tools-version: 6.0
import PackageDescription
let package = Package(
    name: "AgentDeckLocalClient", platforms: [.macOS(.v13)],
    products: [
        .executable(name: "agentdeck-local", targets: ["AgentDeckLocal"]),
        .executable(name: "agentdeck-connect", targets: ["AgentDeckConnect"]),
    ],
    targets: [
        .executableTarget(name: "ContractGenerator"),
        .plugin(name: "CanonicalContract", capability: .buildTool(), dependencies: ["ContractGenerator"]),
        .target(name: "NativeClientCore", plugins: ["CanonicalContract"]),
        .executableTarget(name: "AgentDeckLocal", dependencies: ["NativeClientCore"]),
        .executableTarget(name: "AgentDeckConnect", dependencies: ["NativeClientCore"]),
        .testTarget(name: "NativeClientCoreTests", dependencies: ["NativeClientCore"]),
    ]
)
