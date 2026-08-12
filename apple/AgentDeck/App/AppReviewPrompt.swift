import Foundation
import StoreKit

/// Local-only eligibility for Apple's native App Store review prompt.
///
/// This intentionally records only calendar days on which every live agent
/// session reached an idle pause. Nothing is uploaded and no session id,
/// project name, command, or user identifier is retained.
struct AppReviewPromptPolicy {
    static let reviewURL = URL(
        string: "https://apps.apple.com/app/id6784822497?action=write-review"
    )!

    static func isProductionAppStoreInstall() async -> Bool {
        #if DEBUG
        return false
        #else
        do {
            let result = try await AppTransaction.shared
            guard case .verified(let transaction) = result else { return false }
            return transaction.environment == .production
        } catch {
            return false
        }
        #endif
    }

    static func isNaturalPause(sessionStates: [String?]) -> Bool {
        !sessionStates.isEmpty
            && sessionStates.allSatisfy { $0 == "idle" }
    }

    private enum Keys {
        static let meaningfulUseDays = "appReview.meaningfulUseDays"
        static let lastAttempt = "appReview.lastAttempt"
    }

    private let defaults: UserDefaults
    private let calendar: Calendar
    private let minimumDistinctDays: Int
    private let cooldown: TimeInterval

    init(
        defaults: UserDefaults = .standard,
        calendar: Calendar = .autoupdatingCurrent,
        minimumDistinctDays: Int = 3,
        cooldown: TimeInterval = 180 * 24 * 60 * 60
    ) {
        self.defaults = defaults
        self.calendar = calendar
        self.minimumDistinctDays = minimumDistinctDays
        self.cooldown = cooldown
    }

    func recordMeaningfulUse(at date: Date = Date()) {
        let today = calendar.startOfDay(for: date)
        var days = meaningfulUseDays
        guard !days.contains(today) else { return }

        days.append(today)
        // Three days are enough for eligibility; retaining a small rolling
        // window makes the local state easy to inspect without growing forever.
        defaults.set(Array(days.sorted().suffix(32)), forKey: Keys.meaningfulUseDays)
    }

    func shouldRequestReview(at date: Date = Date()) -> Bool {
        guard meaningfulUseDays.count >= minimumDistinctDays else { return false }
        guard let lastAttempt = defaults.object(forKey: Keys.lastAttempt) as? Date else {
            return true
        }
        return date.timeIntervalSince(lastAttempt) >= cooldown
    }

    func markRequestAttempt(at date: Date = Date()) {
        defaults.set(date, forKey: Keys.lastAttempt)
    }

    private var meaningfulUseDays: [Date] {
        let stored = defaults.array(forKey: Keys.meaningfulUseDays)?.compactMap { $0 as? Date } ?? []
        return Array(Set(stored.map { calendar.startOfDay(for: $0) }))
    }
}
