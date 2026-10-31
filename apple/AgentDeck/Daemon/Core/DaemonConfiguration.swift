#if os(macOS)
import Foundation
import CryptoKit
import CoreFoundation

struct ConfigurationPin: Codable, Sendable, Equatable {
    var id: String
    var weight: Int
    var updatedAt: Int64
    var lastSeenAt: Int64
}
struct PixooConfigurationDevice: Codable, Sendable, Equatable {
    var ip: String
    var name: String?
    var brightness: Int
    var animation: String
}
struct PixooConfiguration: Codable, Sendable, Equatable {
    var devices: [PixooConfigurationDevice]
    var autoDiscover: Bool
    var revision: String { (try? DaemonConfigurationRules.data(self)).map { SHA256.hash(data: $0).map { String(format: "%02x", $0) }.joined() } ?? "" }
}
struct DaemonConfiguration: Codable, Sendable, Equatable {
    var version: Int
    var pins: [ConfigurationPin]
    var pixoo: PixooConfiguration
}
enum DaemonConfigurationRules {
    enum Failure: Error { case invalid, unavailable }
    static func data<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(value)
    }
    static func integer(_ value: Any?) -> Int64? {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite,
              n.doubleValue.rounded() == n.doubleValue, n.doubleValue >= 0,
              n.doubleValue <= Double(DaemonParityRules.configurationMaxCounter) else { return nil }
        return n.int64Value
    }
    private static func keys(_ raw: [String: Any], _ allowed: [String]) -> Bool { Set(raw.keys).isSubset(of: Set(allowed)) }
    static func pixoo(_ raw: Any?) throws -> PixooConfiguration {
        guard let raw = raw as? [String: Any], keys(raw, ["devices", "autoDiscover"]),
              let auto = raw["autoDiscover"] as? NSNumber, CFGetTypeID(auto) == CFBooleanGetTypeID(),
              let rows = raw["devices"] as? [[String: Any]], rows.count <= DaemonParityRules.configurationMaxDevices else { throw Failure.invalid }
        var devices: [PixooConfigurationDevice] = []
        for row in rows {
            guard keys(row, ["ip", "name", "brightness", "animation"]), let ip = row["ip"] as? String,
                  ip.range(of: "^(0|[1-9][0-9]{0,2})(\\.(0|[1-9][0-9]{0,2})){3}$", options: .regularExpression) != nil,
                  ip.split(separator: ".").allSatisfy({ (Int($0) ?? 256) <= 255 }), !devices.contains(where: { $0.ip == ip }),
                  let brightness = integer(row["brightness"]), brightness <= 100,
                  let animation = row["animation"] as? String, DaemonParityRules.configurationAnimations.contains(animation) else { throw Failure.invalid }
            let name = row["name"] as? String
            if row["name"] != nil && (name == nil || name!.unicodeScalars.count > DaemonParityRules.configurationMaxNameChars
                || name!.range(of: "[\\x00-\\x1f\\x7f]", options: .regularExpression) != nil) { throw Failure.invalid }
            devices.append(.init(ip: ip, name: name, brightness: Int(brightness), animation: animation))
        }
        return .init(devices: devices, autoDiscover: auto.boolValue)
    }
    static func parse(_ raw: Any?) throws -> DaemonConfiguration {
        guard let raw = raw as? [String: Any], keys(raw, ["version", "pins", "pixoo"]), integer(raw["version"]) == 1,
              let rows = raw["pins"] as? [[String: Any]], rows.count <= SessionWeightRules.maxSessionOrderPins else { throw Failure.invalid }
        let pixoo = try pixoo(raw["pixoo"])
        var pins: [ConfigurationPin] = []
        for row in rows {
            guard keys(row, ["id", "weight", "updatedAt", "lastSeenAt"]), let id = row["id"] as? String,
                  id.range(of: "^[A-Za-z0-9:_./-]+$", options: .regularExpression) != nil,
                  id.utf8.count <= DaemonParityRules.configurationMaxIdBytes, ObservedAgentRules.rawSessionId(id) == id,
                  !pins.contains(where: { $0.id == id }), let weight = row["weight"] as? NSNumber,
                  CFGetTypeID(weight) != CFBooleanGetTypeID(), weight.doubleValue.rounded() == weight.doubleValue,
                  weight.doubleValue >= Double(SessionWeightRules.min), weight.doubleValue <= Double(SessionWeightRules.max), weight.intValue != 0,
                  let updated = integer(row["updatedAt"]), let seen = integer(row["lastSeenAt"]) else { throw Failure.invalid }
            pins.append(.init(id: id, weight: weight.intValue, updatedAt: updated, lastSeenAt: seen))
        }
        return .init(version: 1, pins: pins.sorted { $0.id < $1.id }, pixoo: pixoo)
    }
}

@DaemonActor
final class DaemonConfigurationStore {
    let directory: URL
    let order: SessionOrderStore
    init(directory: URL, order: SessionOrderStore) { self.directory = directory; self.order = order }
    func root() throws -> [String: Any] {
        do {
            guard let root = try JSONSerialization.jsonObject(with: Data(contentsOf: directory.appendingPathComponent("settings.json"))) as? [String: Any] else { throw DaemonConfigurationRules.Failure.invalid }
            return root
        } catch let e as CocoaError where e.code == .fileReadNoSuchFile { return [:] }
    }
    func pixoo() throws -> PixooConfiguration {
        let root = try root()
        guard root["pixooDevices"] == nil || root["pixooDevices"] is [[String: Any]] else { throw DaemonConfigurationRules.Failure.invalid }
        let rows = (root["pixooDevices"] as? [[String: Any]] ?? []).map { row -> [String: Any] in
            var out: [String: Any] = ["ip": row["ip"] ?? NSNull(), "brightness": row["brightness"] ?? 100, "animation": row["animation"] ?? "single-frame"]
            if let name = row["name"] { out["name"] = name }
            return out
        }
        return try DaemonConfigurationRules.pixoo(["devices": rows, "autoDiscover": (root["pixooAutoDiscover"] as? NSNumber).map { CFGetTypeID($0) == CFBooleanGetTypeID() && $0.boolValue } ?? false])
    }
    func save(_ value: PixooConfiguration) throws {
        var root = try root()
        let prior = root["pixooDevices"] as? [[String: Any]] ?? []
        root["pixooDevices"] = value.devices.map { device -> [String: Any] in
            var row = prior.first { $0["ip"] as? String == device.ip } ?? [:]
            row["ip"] = device.ip; row["name"] = device.name
            row["brightness"] = device.brightness; row["animation"] = device.animation
            return row
        }
        root["pixooAutoDiscover"] = value.autoDiscover
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: root, options: [.sortedKeys, .withoutEscapingSlashes]).write(to: directory.appendingPathComponent("settings.json"), options: .atomic)
    }
    func snapshot() throws -> DaemonConfiguration {
        let file = directory.appendingPathComponent("session-order.json")
        if FileManager.default.fileExists(atPath: file.path) {
            guard let doc = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any],
                  DaemonConfigurationRules.integer(doc["version"]) == 1, let rawPins = doc["pins"] as? [String: [String: Any]] else { throw DaemonConfigurationRules.Failure.invalid }
            let records = rawPins.map { id, pin -> [String: Any] in
                ["id": ObservedAgentRules.rawSessionId(id), "weight": pin["weight"] ?? NSNull(),
                 "updatedAt": pin["updatedAt"] ?? NSNull(), "lastSeenAt": pin["lastSeenAt"] ?? NSNull()]
            }
            _ = try DaemonConfigurationRules.parse(["version": 1, "pins": records, "pixoo": ["devices": [], "autoDiscover": false]])
        }
        return try DaemonConfigurationRules.parse(["version": 1, "pins": order.list(), "pixoo": try JSONSerialization.jsonObject(with: DaemonConfigurationRules.data(pixoo()))])
    }
    func adopt(_ value: DaemonConfiguration) throws {
        let prior = try snapshot()
        guard prior != value else { return }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let archive: [String: Any] = ["configuration": try JSONSerialization.jsonObject(with: DaemonConfigurationRules.data(prior)), "localPixooRows": try root()["pixooDevices"] ?? []]
        try JSONSerialization.data(withJSONObject: archive, options: [.sortedKeys, .withoutEscapingSlashes]).write(to: directory.appendingPathComponent("daemon-configuration-profile-\(UUID().uuidString.lowercased()).json"), options: .atomic)
        try save(value.pixoo)
        try order.replace(value.pins)
    }
}
#endif
