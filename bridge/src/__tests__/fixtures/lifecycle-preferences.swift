// Developer-only bootstrap for the isolated signed lifecycle acceptance app.
// Not an app target or shipped helper. Run before starting the test app.
import Foundation
let args = CommandLine.arguments
precondition(Bundle.main.bundleIdentifier == "bound.serendipity.agent.deck.lifecycle-audit")
precondition(args.count == 2 || (args.count == 3 && args[2] == "--recovery"))
let port = Int(args[1])!
precondition((19450...19459).contains(port))
let defaults = UserDefaults.standard
defaults.set(port, forKey: "prefs.daemonPort")
defaults.set(true, forKey: "prefs.daemonLoopbackOnly")
defaults.set(true, forKey: "prefs.daemonNoDeviceModules")
defaults.set(false, forKey: "prefs.openDashboardOnLaunch")
precondition(defaults.synchronize())
let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
    .appendingPathComponent("AgentDeckLifecycleAcceptance", isDirectory: true)
try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
if args.count == 3 {
    let recovery = dir.appendingPathComponent("RecoveryFixture", isDirectory: true)
    try FileManager.default.createDirectory(at: recovery, withIntermediateDirectories: true)
    defaults.set(try recovery.bookmarkData(options: .withSecurityScope, includingResourceValuesForKeys: nil, relativeTo: nil), forKey: "prefs.recoveryFolderBookmark")
    defaults.set(recovery.path, forKey: "prefs.recoveryFolderPath")
    defaults.set(dir.path, forKey: "prefs.recoveryDataDirectory")
    defaults.set(true, forKey: "prefs.recoveryConfirmed")
    precondition(defaults.synchronize())
}
let settings: [String: Any] = ["apme": ["enabled": false, "judge": ["sampleRate": 0]],
    "llm": ["mlx": ["endpoint": "http://127.0.0.1:19459"]], "pixooAutoDiscover": false]
try JSONSerialization.data(withJSONObject: settings).write(to: dir.appendingPathComponent("settings.json"), options: .atomic)
print(String(data: try JSONSerialization.data(withJSONObject: ["port": defaults.object(forKey: "prefs.daemonPort") as! Int,
    "loopbackOnly": defaults.bool(forKey: "prefs.daemonLoopbackOnly"), "noDeviceModules": defaults.bool(forKey: "prefs.daemonNoDeviceModules"),
    "bundleID": Bundle.main.bundleIdentifier!, "dataDirectory": dir.path]), encoding: .utf8)!)
