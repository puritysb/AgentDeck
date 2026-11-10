// GENERATED from shared/src/ci-provider-policy.ts and ci-wait.ts.
#if os(macOS)
enum GitHubCIPolicy {
    static let apiVersion = "2026-03-10"
    static let requestSeconds = 8
    static let probeSeconds = 20
    static let maxBodyBytes = 262144
    static let pageSize = 100
    static let maxPages = 10
    static let pollMs = 30000
    static let freshMs = 90000
    static let tickSeconds = 2
    static let maxConcurrent = 4
    static let maxRepositories = 32
    static let maxBackoffSeconds = 86400
    static let nonBlockingConclusions = ["skipped","neutral"]
    static let maxIdentityChars = 255
    static let maxId: Double = 9007199254740991
    static let repoPattern = "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"
    static let refPattern = "^[A-Za-z0-9_./-]+$"
    static let resultAgeMs = 30000
}
#endif
