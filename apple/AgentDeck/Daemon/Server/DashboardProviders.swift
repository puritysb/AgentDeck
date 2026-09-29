// DashboardProviders.swift — the Swift mirror of the dashboard
// display-preference resolver (bridge/src/dashboard-providers.ts), per the
// cross-daemon rule: a near-transliteration, not a restatement, because the
// same settings.json must not render differently depending on which daemon
// holds the port. Behavior is pinned by shared/dashboard-provider-vectors.json,
// replayed by BOTH suites (dashboard-provider-vectors.test.ts and
// DashboardProviderVectorsTests).
//
// #351: a provider id the user has NEVER been offered (absent from the seen
// superset AND the saved list) joins the saved list exactly once, gated on the
// daemon currently seeing it live. A deliberate later hide keeps the id in
// `seen`, so the hide always wins. Initialisation (the client's automatic
// discovery snapshot) marks only the discovered ids seen; a manual save marks
// the full vocabulary seen — the menu offers every id.

import Foundation

enum DashboardProviders {
    /// Display membership only; kept in lockstep with the TS vocabulary by
    /// `generate-dashboard-providers` (emits the same list into DaemonServer
    /// and TopologyRail).
    static let providerIds: [String] = ["claude", "codex", "zai", "openclaw", "mlx", "ollama", "antigravity"]

    /// Provider ids whose vocabulary predates the seen-superset mechanism
    /// (#351). FROZEN: a saved preference with no `seen` key could only have
    /// been offered these, so for them the list's absence is a deliberate
    /// choice. `zai` shipped in the same release as the mechanism and is the
    /// first join-eligible id; every later vocabulary addition follows.
    static let preSeenMechanismIds: [String] = ["claude", "codex", "openclaw", "mlx", "ollama", "antigravity"]

    struct Prefs: Equatable {
        var providers: [String]?
        var seen: [String]?
    }

    struct Update {
        var providers: [Any]
        var initialize: Bool
    }

    /// The one decision — pure. Throws `TypeError.invalidProviders` on a bad
    /// POST body (the caller maps it to HTTP 400).
    enum ResolutionError: Error {
        case invalidProviders
    }

    static func resolve(
        _ prefs: Prefs,
        update: Update?,
        confirmed: [String] = []
    ) throws -> Prefs {
        var providers = prefs.providers
        var seen = prefs.seen
        // `seen` persists in vocabulary order (like `providers` itself), so the
        // two daemons' files stay comparable.
        func orderSeen(_ ids: [String]) -> [String] {
            providerIds.filter(ids.contains)
        }

        if let update {
            let values = update.providers.filter { $0 is String }.map { $0 as! String }
            guard values.count == update.providers.count,
                  values.allSatisfy(providerIds.contains) else {
                throw ResolutionError.invalidProviders
            }
            // First registration cannot overwrite a saved choice, including an
            // empty list.
            if update.initialize != true || providers == nil {
                providers = providerIds.filter(values.contains)
            }
            // The initialize snapshot is automatic: only the ids it names were
            // "offered". A manual save went through the menu, which offers the
            // whole vocabulary.
            let offered: [String] = update.initialize ? values : providerIds
            var merged = Set(seen ?? [])
            merged.formUnion(offered)
            seen = orderSeen(Array(merged))
            return Prefs(providers: providers, seen: seen)
        }

        // Read path: join confirmed-but-never-offered ids into a saved list,
        // once. A legacy save (no seen key) could only have been offered the
        // frozen pre-mechanism ids — persist that baseline so the join set is
        // explicit.
        if let savedList = providers {
            let seenIds = seen ?? orderSeen(preSeenMechanismIds)
            let joins = providerIds.filter {
                confirmed.contains($0) && !seenIds.contains($0) && !savedList.contains($0)
            }
            if !joins.isEmpty { providers = savedList + joins }
            seen = orderSeen(seenIds + joins)
        }
        return Prefs(providers: providers, seen: seen)
    }
}
