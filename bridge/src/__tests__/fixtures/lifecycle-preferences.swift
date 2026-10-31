// Developer-only bootstrap for the isolated signed lifecycle acceptance app.
// Not an app target or shipped helper. Run before starting the test app.
import Foundation
let args = CommandLine.arguments
precondition(Bundle.main.bundleIdentifier == "bound.serendipity.agent.deck.lifecycle-audit")
precondition(args.count == 2)
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
let settings: [String: Any] = ["apme": ["enabled": false, "judge": ["sampleRate": 0]],
    "llm": ["mlx": ["endpoint": "http://127.0.0.1:19459"]], "pixooAutoDiscover": false]
try JSONSerialization.data(withJSONObject: settings).write(to: dir.appendingPathComponent("settings.json"), options: .atomic)
print(String(data: try JSONSerialization.data(withJSONObject: ["port": defaults.object(forKey: "prefs.daemonPort") as! Int,
    "loopbackOnly": defaults.bool(forKey: "prefs.daemonLoopbackOnly"), "noDeviceModules": defaults.bool(forKey: "prefs.daemonNoDeviceModules"),
    "bundleID": Bundle.main.bundleIdentifier!, "dataDirectory": dir.path]), encoding: .utf8)!)
