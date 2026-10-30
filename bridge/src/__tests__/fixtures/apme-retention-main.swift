import Foundation
import SQLite3

struct Input: Decodable { let path: String; let cutoffMs: Int64; let prunedAt: Int64 }
struct Output: Encodable { let preview: ApmePrunePreview; let applied: ApmePrunePreview }
@main struct RetentionFixture {
    static func main() throws {
        let input = try JSONDecoder().decode(Input.self, from: FileHandle.standardInput.readDataToEndOfFile())
        var db: OpaquePointer?
        guard sqlite3_open_v2(input.path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK,
              let db else { throw ApmeStorageError.unavailable }
        defer { sqlite3_close_v2(db) }
        let worker = ApmeRetention(db: db, path: input.path)
        let preview = try worker.preview(cutoffMs: input.cutoffMs)
        let applied = try worker.apply(cutoffMs: input.cutoffMs, expectedFingerprint: preview.fingerprint, prunedAt: input.prunedAt)
        print(String(decoding: try JSONEncoder().encode(Output(preview: preview, applied: applied)), as: UTF8.self))
    }
}
