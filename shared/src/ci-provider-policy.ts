// SSOT for native GitHub provider transport/freshness limits.
export const CI_PROVIDER_POLICY = {
  apiVersion: '2026-03-10', requestSeconds: 8, probeSeconds: 20,
  maxBodyBytes: 262144, pageSize: 100, maxPages: 10,
  pollMs: 30000, freshMs: 90000, tickSeconds: 2, maxConcurrent: 4,
  maxRepositories: 32, maxBackoffSeconds: 86400,
  // Completed check runs that neither validate nor block, as in `gh pr checks`
  // and the merge box. They are left out of a commit's verdict and counts; a
  // commit with nothing else stays unknown. Cancelled is not in this list.
  nonBlockingConclusions: ['skipped', 'neutral'],
} as const;
