#if os(macOS)
// ProjectNameResolver.swift — derive a stable project label from a Claude
// Code hook payload or a cwd string.
//
// Mirrors `bridge/src/utils/project-name.ts`. Pure Foundation: no subprocess,
// so this is safe on the App Store build (AGENTDECK_APP_STORE) without any
// conditional compilation. When the daemon is sandboxed and the cwd is
// outside the app container, FileManager returns false for fileExists and
// the resolver falls through to `lastPathComponent` — matching the legacy
// behaviour, no regression.

import Foundation

enum ProjectNameResolver {
    private static let maxWalkDepth = 32

    /// Order:
    ///   1. `json["project_name"]` if non-empty
    ///   2. AGENTDECK_PROJECT_NAME env var
    ///   3. `resolve(cwd:)` on `json["cwd"]`
    ///   4. ""
    static func projectName(fromHookPayload json: [String: Any]) -> String {
        if let p = json["project_name"] as? String, !p.isEmpty { return p }
        if let env = ProcessInfo.processInfo.environment["AGENTDECK_PROJECT_NAME"],
           !env.trimmingCharacters(in: .whitespaces).isEmpty {
            return env.trimmingCharacters(in: .whitespaces)
        }
        if let cwd = json["cwd"] as? String, !cwd.isEmpty {
            return resolve(cwd: cwd)
        }
        return ""
    }

    /// Pure cwd-based resolution. Walk for `.git/` marker → basename, then
    /// walk for `package.json` with non-empty `name`, finally
    /// `lastPathComponent`. Returns "" when the cwd has no usable basename
    /// (filesystem root) so callers substitute their own fallback label.
    static func resolve(cwd: String) -> String {
        if let git = gitToplevelBasename(startingAt: cwd) { return git }
        if let pkg = nearestPackageJsonName(startingAt: cwd) { return pkg }
        let base = (cwd as NSString).lastPathComponent
        // NSString.lastPathComponent maps the filesystem root to "/" where
        // Node's `basename('/')` maps it to "" (project-name.ts then falls
        // through to 'unknown'). Codex App ambient tasks run at cwd "/", so
        // without this guard their sessions surfaced a literal "/" as the
        // project label on every dashboard.
        if base == "/" { return "" }
        return base
    }

    /// Walk ancestors looking for a `.git` entry (directory OR file — submodule
    /// and worktree layouts store it as a file). Returns the repo root's
    /// basename.
    static func gitToplevelBasename(startingAt cwd: String, compact: Bool = false) -> String? {
        var dir = (cwd as NSString).standardizingPath
        let fm = FileManager.default
        for _ in 0..<maxWalkDepth {
            let gitPath = (dir as NSString).appendingPathComponent(".git")
            if fm.fileExists(atPath: gitPath) {
                return gitProjectLabel(root: dir, compact: compact)
            }
            let parent = (dir as NSString).deletingLastPathComponent
            if parent == dir || parent.isEmpty { return nil }
            dir = parent
        }
        return nil
    }

    /// Mirrors the linked-worktree contract pinned by shared/project-name-vectors.json.
    /// Unreadable metadata, submodules and bare repositories retain the local name.
    private static func gitProjectLabel(root: String, compact: Bool = false) -> String? {
        let localName = (root as NSString).lastPathComponent
        let fallback = localName.isEmpty ? nil : localName
        func read(_ path: String) -> String? {
            (try? String(contentsOfFile: path, encoding: .utf8))?
                .trimmingCharacters(in: .whitespacesAndNewlines)
        }
        func resolve(_ path: String, from base: String) -> String {
            let absolute = (path as NSString).isAbsolutePath
                ? path : (base as NSString).appendingPathComponent(path)
            return (absolute as NSString).standardizingPath
        }
        guard let marker = read((root as NSString).appendingPathComponent(".git")),
              marker.hasPrefix("gitdir:") else { return fallback }
        let pointer = String(marker.dropFirst("gitdir:".count))
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !pointer.isEmpty else { return fallback }
        let gitDir = resolve(pointer, from: root)
        guard let commonPointer = read((gitDir as NSString).appendingPathComponent("commondir")),
              !commonPointer.isEmpty else { return fallback }
        let commonDir = resolve(commonPointer, from: gitDir)
        guard (commonDir as NSString).lastPathComponent == ".git",
              FileManager.default.fileExists(atPath: (commonDir as NSString).appendingPathComponent("HEAD"))
        else { return fallback }
        let repositoryName = ((commonDir as NSString).deletingLastPathComponent as NSString).lastPathComponent
        return repositoryName.isEmpty ? fallback : (compact ? repositoryName : "\(repositoryName) · \(localName)")
    }

    static func compactProjectName(_ name: String, cwd: String?) -> String {
        guard let cwd, resolve(cwd: cwd) == name else { return name }
        return gitToplevelBasename(startingAt: cwd, compact: true) ?? name
    }

    /// Walk ancestors looking for a `package.json` whose `name` field is a
    /// non-empty string. Returns the name verbatim (scoped names preserved).
    static func nearestPackageJsonName(startingAt cwd: String) -> String? {
        var dir = (cwd as NSString).standardizingPath
        let fm = FileManager.default
        for _ in 0..<maxWalkDepth {
            let pkgPath = (dir as NSString).appendingPathComponent("package.json")
            if let data = fm.contents(atPath: pkgPath),
               let obj = try? JSONSerialization.jsonObject(with: data),
               let dict = obj as? [String: Any],
               let rawName = dict["name"] as? String {
                let trimmed = rawName.trimmingCharacters(in: .whitespaces)
                if !trimmed.isEmpty { return trimmed }
            }
            let parent = (dir as NSString).deletingLastPathComponent
            if parent == dir || parent.isEmpty { return nil }
            dir = parent
        }
        return nil
    }
}
#endif
