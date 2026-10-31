// Developer-only physical acceptance. Links the actual Debug app objects; not
// an app target, subprocess path or shipped helper. No other module is started.
import Foundation
@testable import AgentDeck

@main struct Main {
    enum Failure: Error { case invalid, upload }
    static func main() async throws {
        let args = CommandLine.arguments
        guard args.count >= 3, args[1].range(of:#"^\d{1,3}(?:\.\d{1,3}){3}$"#,options:.regularExpression) != nil else { throw Failure.invalid }
        let ip = args[1], out = URL(fileURLWithPath:args[2],isDirectory:true)
        func query(_ command:String) async throws -> [String:Any] {
            var r=URLRequest(url:URL(string:"http://\(ip)/post")!,timeoutInterval:3)
            r.httpMethod="POST";r.httpBody=try JSONSerialization.data(withJSONObject:["Command":command]);r.setValue("application/json",forHTTPHeaderField:"Content-Type");r.setValue("close",forHTTPHeaderField:"Connection")
            let (data,response)=try await URLSession.shared.data(for:r)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw Failure.invalid }
            return try JSONSerialization.jsonObject(with:data) as! [String:Any]
        }
        func record(_ name:String,_ value:[String:Any]) throws {
            guard JSONSerialization.isValidJSONObject(value) else { throw Failure.invalid }
            try JSONSerialization.data(withJSONObject:value,options:[.prettyPrinted,.sortedKeys]).write(to:out.appendingPathComponent(name+".json"),options:.atomic)
        }
        if args.contains("--probe") {
            try record("driver-probe",try await query("Channel/GetAllConf"))
            let core=try PixooBakedRenderer();let frames=try core.render(state:["state":"processing","agentType":"claude-code"],usage:nil,sessions:nil,nowMs:1_793_424_000_000)
            print("Actual module driver ready; core frames=\(frames.count)");return
        }
        let before=try await query("Channel/GetAllConf"), channel=try await query("Channel/GetIndex")
        guard let brightness=before["Brightness"] as? Int, let selected=channel["SelectIndex"] as? Int, selected == 3 else { throw Failure.invalid }
        let module=PixooModule(settingsLoader:{[.init(ip:ip,brightness:brightness,animation:"loop")]})
        func restore() async throws {
            await module.stop()
            let tide=PixooModule(settingsLoader:{[.init(ip:ip,brightness:brightness,animation:"tide")]})
            let events=try JSONSerialization.jsonObject(with:Data(contentsOf:out.appendingPathComponent("restore-events.json"))) as! [[String:Any]]
            let payloads=try events.map {try JSONSerialization.data(withJSONObject:$0)}
            for payload in payloads {await tide.handleEvent(try JSONSerialization.jsonObject(with:payload) as! [String:Any])}
            await tide.reloadFromSettingsExternal();await tide.checkAndPush()
            try record("hardware-restored",tide.statusSnapshot())
            let final=try await query("Channel/GetAllConf");try record("hardware-final",final)
            guard final["Brightness"] as? Int == brightness, (tide.statusSnapshot()["lastPushError"] as? String ?? "").isEmpty else { throw Failure.upload }
            // No scheduler was started. Releasing the one-shot restoration
            // module leaves Tide playing on the panel without a second producer.
        }
        do {
            await module.handleEvent(["type":"state_update","state":"processing","agentType":"claude-code"])
            await module.handleEvent(["type":"usage_update","fiveHourPercent":45,"sevenDayPercent":21])
            await module.handleEvent(["type":"sessions_list","sessions":[
                ["id":"fixture-claude","agentType":"claude-code","state":"processing","alive":true],
                ["id":"fixture-opencode","agentType":"opencode","state":"processing","alive":true],
                ["id":"fixture-hermes","agentType":"hermes","state":"idle","alive":true]]])
            await module.reloadFromSettingsExternal();await module.checkAndPush()
            guard (module.statusSnapshot()["lastPushError"] as? String ?? "").isEmpty else {throw Failure.upload}
            try record("hardware-loop",module.statusSnapshot())
            let played=try await query("Draw/GetHttpGifId");try record("hardware-loop-counter",played)
            print("LOOP_READY");fflush(stdout)
            for _ in 0..<180 {if FileManager.default.fileExists(atPath:out.appendingPathComponent("hardware-continue").path) {break};try await Task.sleep(for:.seconds(1))}
            await module.handleEvent(["type":"display_state","displayOn":false,"dim":["enabled":true,"mode":"min","level":7]])
            try await Task.sleep(for:.seconds(1));let dim=try await query("Channel/GetAllConf");try record("hardware-dim",dim)
            guard dim["Brightness"] as? Int == 7 else {throw Failure.upload}
            try await Task.sleep(for:.seconds(10));await module.checkAndPush()
            let slept=try await query("Draw/GetHttpGifId");try record("hardware-sleep-counter",slept)
            guard slept["PicId"] as? Int == played["PicId"] as? Int else {throw Failure.upload}
            await module.handleEvent(["type":"display_state","displayOn":true])
            try await Task.sleep(for:.seconds(1));await module.checkAndPush()
            let awake=try await query("Channel/GetAllConf");try record("hardware-wake",awake);try record("hardware-wake-module",module.statusSnapshot())
            guard awake["Brightness"] as? Int == brightness, (module.statusSnapshot()["lastPushError"] as? String ?? "").isEmpty else {throw Failure.upload}
            try await restore();print("HARDWARE_ACCEPTED_AND_RESTORED")
        } catch {try await restore();throw error}
    }
}
