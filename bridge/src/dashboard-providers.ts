import { loadDaemonSettings, updateDaemonSetting } from './daemon-settings.js';

/** Display membership only; independent of observation, quota and connectivity. */
export const DASHBOARD_PROVIDER_IDS = ['claude', 'codex', 'zai', 'openclaw', 'mlx', 'ollama', 'antigravity'] as const;

/**
 * Provider ids whose vocabulary predates the seen-superset mechanism (#351).
 *
 * A saved preference with no `dashboardProvidersSeen` key was written by a
 * build whose menu could only have offered these ids, so for THEM the list's
 * absence is respected as a deliberate choice — nobody can have deliberately
 * hidden an id they were never offered. This list is FROZEN: an id added to
 * the vocabulary later is by definition absent here and is therefore the first
 * eligible for the additive join. `zai` shipped in the same release as the
 * mechanism, so it joins for upgrading users (measured live: a saved list from
 * before z.ai hid the live provider row until manually toggled).
 */
export const PRE_SEEN_MECHANISM_PROVIDER_IDS: readonly string[] = [
  'claude', 'codex', 'openclaw', 'mlx', 'ollama', 'antigravity',
];

/** Persisted display-preference state (`dashboardProviders` + `dashboardProvidersSeen`). */
export interface DashboardProviderPrefs {
  providers: string[] | null;
  seen: string[] | null;
}

/** A POST body: `providers` (unvalidated here) + the initialize flag. */
export interface DashboardProviderUpdate {
  providers: unknown;
  initialize?: boolean;
}

/**
 * The one decision both daemons make identically (#351). Pure — the caller
 * loads, persists and serves; this resolves. Mirrored in Swift
 * (`DashboardProviders.swift`, a near-transliteration per the cross-daemon
 * rule) and pinned by `shared/dashboard-provider-vectors.json`, replayed by
 * BOTH suites, because the same settings file must not render differently
 * depending on which daemon holds the port.
 *
 * `confirmed` is the set of provider ids the daemon can currently see live
 * (usage/auth state). A confirmed id that the user has NEVER been offered
 * (absent from the seen superset AND from the saved list) joins the saved
 * list exactly once. A deliberate later hide keeps the id in `seen`, so the
 * hide always wins. Initialisation (the client's automatic discovery
 * snapshot) marks only the DISCOVERED ids as seen; a manual save marks the
 * FULL vocabulary seen — the menu offers every id, so the user has expressed
 * a choice about each.
 */
export function resolveDashboardProviders(
  prefs: DashboardProviderPrefs,
  update: DashboardProviderUpdate | null,
  confirmed: readonly string[] = [],
): DashboardProviderPrefs {
  let providers = prefs.providers;
  let seen = prefs.seen;
  // `seen` persists in vocabulary order (like `providers` itself), so the two
  // daemons' files stay byte-comparable and a diff reads as a set change.
  const orderSeen = (ids: readonly string[]): string[] =>
    DASHBOARD_PROVIDER_IDS.filter(id => ids.includes(id));

  if (update) {
    if (!Array.isArray(update.providers) || update.providers.some(p =>
      !(DASHBOARD_PROVIDER_IDS as readonly unknown[]).includes(p))) {
      throw new TypeError('Invalid providers');
    }
    // First registration cannot overwrite a saved choice, including an empty list.
    if (update.initialize !== true || !Array.isArray(providers)) {
      providers = DASHBOARD_PROVIDER_IDS.filter(p => (update.providers as string[]).includes(p));
    }
    // The initialize snapshot is automatic: only the ids it names were
    // "offered". A manual save went through the menu, which offers the whole
    // vocabulary — every id has now been seen and can never auto-join.
    const offered: readonly string[] = update.initialize === true
      ? (update.providers as string[])
      : DASHBOARD_PROVIDER_IDS;
    const merged = new Set([...(seen ?? []), ...offered]);
    seen = orderSeen([...merged]);
    return { providers, seen };
  }

  // Read path: join confirmed-but-never-offered ids into a saved list, once.
  const savedList = providers as string[] | null;
  if (Array.isArray(savedList)) {
    // A legacy save (no seen key) could only have been offered the frozen
    // pre-mechanism ids — persist that baseline so the join set is explicit.
    const seenIds = seen ?? orderSeen(PRE_SEEN_MECHANISM_PROVIDER_IDS);
    const joins = DASHBOARD_PROVIDER_IDS.filter(id =>
      confirmed.includes(id) && !seenIds.includes(id) && !savedList.includes(id));
    if (joins.length > 0) providers = [...savedList, ...joins];
    seen = orderSeen([...seenIds, ...joins]);
  }
  return { providers, seen };
}

/** HTTP handler surface: resolve against the persisted settings and save changes. */
export function dashboardProviders(
  update?: Record<string, unknown>,
  confirmed: readonly string[] = [],
): string[] | null {
  const settings = loadDaemonSettings();
  const before: DashboardProviderPrefs = {
    providers: Array.isArray(settings.dashboardProviders) ? settings.dashboardProviders as string[] : null,
    seen: Array.isArray(settings.dashboardProvidersSeen) ? settings.dashboardProvidersSeen as string[] : null,
  };
  const after = resolveDashboardProviders(before, (update ?? null) as DashboardProviderUpdate | null, confirmed);
  if (after.providers !== before.providers) updateDaemonSetting('dashboardProviders', after.providers);
  if (after.seen !== before.seen) updateDaemonSetting('dashboardProvidersSeen', after.seen);
  return after.providers;
}
