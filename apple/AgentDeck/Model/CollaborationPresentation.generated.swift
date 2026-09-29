// GENERATED from shared/src/collaboration-presentation.ts. DO NOT EDIT.
enum CollaborationPresentation {
    static let heading = "Collaboration"
    static let scope = "Live session census"
    static let labels = ["Subagents active","Done this wave","Spawned running","Jobs waited on"]
    static let symbols = ["circle.dotted","checkmark.circle","arrow.up.right.circle","hourglass"]
    static func phase(_ attention: Bool, _ working: Bool, _ children: Int, _ spawned: Int, _ jobs: Int) -> Int {
        return attention ? 0 : working ? 1 : children > 0 || spawned > 0 || jobs > 0 ? 2 : 3
    }
}
