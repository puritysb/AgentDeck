// ProjectNameResolverTests.swift — Swift mirror of
// bridge/src/__tests__/project-name.test.ts. Verifies the cwd → project name
// fallback chain used by DaemonServer when synthesizing sessions from Claude
// Code hook payloads.

#if os(macOS)
import XCTest
@testable import AgentDeck

final class ProjectNameResolverTests: XCTestCase {

    private var tmpRoot: URL!

    override func setUpWithError() throws {
        tmpRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("project-name-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmpRoot, withIntermediateDirectories: true)
        unsetenv("AGENTDECK_PROJECT_NAME")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: tmpRoot)
        unsetenv("AGENTDECK_PROJECT_NAME")
    }

    func testSharedWorktreeProjectLabelVectors() throws {
        struct Vector: Decodable {
            let name: String
            let cwd: String
            let files: [String: String]
            let expected: String
        }
        let fixture = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shared/project-name-vectors.json")
        let vectors = try JSONDecoder().decode([Vector].self, from: Data(contentsOf: fixture))
        for vector in vectors {
            let root = tmpRoot.appendingPathComponent(UUID().uuidString)
            let cwd = root.appendingPathComponent(vector.cwd)
            try mkdir(cwd)
            for (path, content) in vector.files {
                let destination = root.appendingPathComponent(path)
                try mkdir(destination.deletingLastPathComponent())
                try write(destination, content.replacingOccurrences(of: "$ROOT", with: root.path))
            }
            XCTAssertEqual(ProjectNameResolver.resolve(cwd: cwd.path), vector.expected, vector.name)
        }
    }

    // MARK: - Helpers

    private func mkdir(_ path: URL) throws {
        try FileManager.default.createDirectory(at: path, withIntermediateDirectories: true)
    }

    private func write(_ url: URL, _ contents: String) throws {
        try contents.write(to: url, atomically: true, encoding: .utf8)
    }

    // MARK: - gitToplevelBasename

    func testGitMarkerAsDirectory() throws {
        let repo = tmpRoot.appendingPathComponent("ReporA")
        let sub = repo.appendingPathComponent("a/b")
        try mkdir(sub)
        try mkdir(repo.appendingPathComponent(".git"))
        XCTAssertEqual(ProjectNameResolver.gitToplevelBasename(startingAt: sub.path), "ReporA")
    }

    func testGitMarkerAsFile() throws {
        // Worktree / submodule layouts store .git as a file pointing at the real dir.
        let repo = tmpRoot.appendingPathComponent("Worktree")
        let sub = repo.appendingPathComponent("nested")
        try mkdir(sub)
        try write(repo.appendingPathComponent(".git"), "gitdir: /elsewhere\n")
        XCTAssertEqual(ProjectNameResolver.gitToplevelBasename(startingAt: sub.path), "Worktree")
    }

    func testNoGitReturnsNil() throws {
        let dir = tmpRoot.appendingPathComponent("alone")
        try mkdir(dir)
        XCTAssertNil(ProjectNameResolver.gitToplevelBasename(startingAt: dir.path))
    }

    // MARK: - nearestPackageJsonName

    func testNearestPackageJsonWins() throws {
        let outer = tmpRoot.appendingPathComponent("o")
        let inner = outer.appendingPathComponent("i")
        let leaf = inner.appendingPathComponent("l")
        try mkdir(leaf)
        try write(outer.appendingPathComponent("package.json"), #"{"name":"outer"}"#)
        try write(inner.appendingPathComponent("package.json"), #"{"name":"@scope/inner"}"#)
        XCTAssertEqual(ProjectNameResolver.nearestPackageJsonName(startingAt: leaf.path), "@scope/inner")
    }

    func testEmptyNameSkipped() throws {
        let outer = tmpRoot.appendingPathComponent("o")
        let inner = outer.appendingPathComponent("i")
        try mkdir(inner)
        try write(outer.appendingPathComponent("package.json"), #"{"name":"outer"}"#)
        try write(inner.appendingPathComponent("package.json"), #"{"name":""}"#)
        XCTAssertEqual(ProjectNameResolver.nearestPackageJsonName(startingAt: inner.path), "outer")
    }

    func testMalformedPackageJsonIgnored() throws {
        let outer = tmpRoot.appendingPathComponent("o")
        let inner = outer.appendingPathComponent("i")
        try mkdir(inner)
        try write(outer.appendingPathComponent("package.json"), #"{"name":"outer"}"#)
        try write(inner.appendingPathComponent("package.json"), "{not json")
        XCTAssertEqual(ProjectNameResolver.nearestPackageJsonName(startingAt: inner.path), "outer")
    }

    func testNoPackageJsonReturnsNil() throws {
        let dir = tmpRoot.appendingPathComponent("nothing")
        try mkdir(dir)
        XCTAssertNil(ProjectNameResolver.nearestPackageJsonName(startingAt: dir.path))
    }

    // MARK: - resolve(cwd:)

    func testResolvePrefersGitOverPackageJson() throws {
        let repo = tmpRoot.appendingPathComponent("Gamma")
        let leaf = repo.appendingPathComponent("sub")
        try mkdir(leaf)
        try mkdir(repo.appendingPathComponent(".git"))
        try write(leaf.appendingPathComponent("package.json"), #"{"name":"sub-only"}"#)
        XCTAssertEqual(ProjectNameResolver.resolve(cwd: leaf.path), "Gamma")
    }

    func testResolveFallsBackToCwdBasename() throws {
        let dir = tmpRoot.appendingPathComponent("barename")
        try mkdir(dir)
        XCTAssertEqual(ProjectNameResolver.resolve(cwd: dir.path), "barename")
    }

    func testResolveFilesystemRootReturnsEmpty() {
        // Codex App ambient tasks run at cwd "/" — NSString.lastPathComponent
        // returns "/" for it (Node's basename returns ""), which leaked a
        // literal "/" project label onto dashboards. Degenerate basenames
        // must read as unresolved so callers apply their own fallback.
        XCTAssertEqual(ProjectNameResolver.resolve(cwd: "/"), "")
    }

    func testResolveTrailingSlashStillResolvesBasename() throws {
        let dir = tmpRoot.appendingPathComponent("slashy")
        try mkdir(dir)
        XCTAssertEqual(ProjectNameResolver.resolve(cwd: dir.path + "/"), "slashy")
    }

    // MARK: - projectName(fromHookPayload:)

    func testEmptyPayloadReturnsEmpty() {
        XCTAssertEqual(ProjectNameResolver.projectName(fromHookPayload: [:]), "")
    }

    func testExplicitProjectNameWinsInPayload() throws {
        let repo = tmpRoot.appendingPathComponent("RepoInTmp")
        try mkdir(repo.appendingPathComponent(".git"))
        let payload: [String: Any] = ["project_name": "Explicit", "cwd": repo.path]
        XCTAssertEqual(ProjectNameResolver.projectName(fromHookPayload: payload), "Explicit")
    }

    func testCwdFallsThroughToGit() throws {
        let repo = tmpRoot.appendingPathComponent("ViaCwd")
        let sub = repo.appendingPathComponent("apple")
        try mkdir(sub)
        try mkdir(repo.appendingPathComponent(".git"))
        let payload: [String: Any] = ["cwd": sub.path]
        XCTAssertEqual(ProjectNameResolver.projectName(fromHookPayload: payload), "ViaCwd")
    }

    func testEnvVarWinsOverGit() throws {
        let repo = tmpRoot.appendingPathComponent("WouldBeRepoName")
        try mkdir(repo.appendingPathComponent(".git"))
        setenv("AGENTDECK_PROJECT_NAME", "FromEnv", 1)
        defer { unsetenv("AGENTDECK_PROJECT_NAME") }
        let payload: [String: Any] = ["cwd": repo.path]
        XCTAssertEqual(ProjectNameResolver.projectName(fromHookPayload: payload), "FromEnv")
    }

    func testExplicitProjectNameBeatsEnvVar() {
        setenv("AGENTDECK_PROJECT_NAME", "FromEnv", 1)
        defer { unsetenv("AGENTDECK_PROJECT_NAME") }
        let payload: [String: Any] = ["project_name": "Explicit", "cwd": "/any"]
        XCTAssertEqual(ProjectNameResolver.projectName(fromHookPayload: payload), "Explicit")
    }
}
#endif
