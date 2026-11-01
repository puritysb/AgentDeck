import Foundation
@main struct Main {
 static func main() throws {
  let source = try String(contentsOfFile: CommandLine.arguments[1],encoding:.utf8)
  let renderer = try PixooBakedRenderer(source: source)
  let input = try JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as! [[String:Any]]
  if CommandLine.arguments.contains("--signatures") {
   let values = input.map { v in renderer.signature(state:v["state"] as? [String:Any],usage:v["usage"] as? [String:Any],sessions:v["sessions"] as? [[String:Any]] ?? [],timeline:v["timeline"] as? [[String:Any]] ?? [],nowMs:(v["nowMs"] as! NSNumber).doubleValue) ?? "invalid" }
   print(String(data:try JSONSerialization.data(withJSONObject:values),encoding:.utf8)!); return
  }
  var out:[[String]]=[]
  for v in input { let frames = try renderer.render(state:v["state"] as? [String:Any],usage:v["usage"] as? [String:Any],sessions:v["sessions"] as? [[String:Any]],subagents:v["subagents"] as? [String:Any],timeline:v["timeline"] as? [[String:Any]] ?? [],nowMs:(v["nowMs"] as! NSNumber).doubleValue,loop:v["loop"] as? Bool ?? true);out.append(frames.map{$0.base64EncodedString()}) }
  print(String(data:try JSONSerialization.data(withJSONObject:out),encoding:.utf8)!)
 }
}
