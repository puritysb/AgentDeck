// GENERATED from shared/src/pocket-policy.ts. Do not edit.
#if os(macOS)
enum PocketPolicy {
    static let stateRev: Double = 1
    static let hourBuckets: Double = 6
    static let bucketHours: Double = 4
    static let noResponseMs: Double = 86400000
    static let keepSeenMs: Double = 1209600000
    static let keepPendingMs: Double = 604800000
    static let surveyIntervalMs: Double = 604800000
    static let surveyFeedbackInterval: Double = 12
    static let initialSurveyFeedback: Double = 2
    static let pendingLimit: Double = 64
    static let persistDelayMs: Double = 50
    static let defaultMaxCards: Double = 2
    static let minCards: Double = 1
    static let maxCards: Double = 3
    static let defaultExploration: Double = 0.65
    static let maxExploration: Double = 2
    static let ignoredWeight: Double = 0.15
    static let positivePrior: Double = 1
    static let totalPrior: Double = 2
    static let explorationTotalPrior: Double = 2
    static let explorationShownPrior: Double = 1
    static let affinityWeight: Double = 0.25
    static let cooldownMs: Double = 21600000
    static let cooldownPenalty: Double = 0.45
    static let unseenBonus: Double = 0.35
    static let usageThreshold: Double = 80
    static let agendaPriority: Double = 0.9
    static let weatherPriority: Double = 1
    static let usagePriority: Double = 0.85
    static let lowUsagePriority: Double = 0.45
    static let attentionPriority: Double = 0.95
    static let progressPriority: Double = 0.7
    static let resumePriority: Double = 0.55
    static let overviewPriority: Double = 0.35
    static let preferencePriority: Double = 2
    static let usefulReward: Double = 1
    static let moreReward: Double = 2
    static let lessPenalty: Double = 2
    static let preferenceReward: Double = 2
    static let surpriseReward: Double = 1
    static let attentionLines: Double = 3
    static let overviewLines: Double = 4
    static let titleBytes: Double = 24
    static let questionBytes: Double = 160
    static let contextBytes: Double = 96
    static let choiceIdBytes: Double = 31
    static let choiceLabelBytes: Double = 40
    static let maxChoices: Double = 3
    static let contextLines: Double = 4
    static let kinds: [String] = ["agenda","weather","usage","attention","progress","resume","overview","preference"]
    static let cardIDPattern = "^module:(?:pulse:auto:overview|quest:auto:preference|nudge:auto:(?:agenda|weather|usage|attention|progress|resume)):[0-9]{8}:[0-9a-f]{8}$"
}
#endif
