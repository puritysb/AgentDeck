// SSOT for native GitHub provider transport/freshness limits.
export const CI_PROVIDER_POLICY = {
  apiVersion: '2026-03-10', requestSeconds: 8, probeSeconds: 20,
  maxBodyBytes: 262144, pageSize: 100, maxPages: 10,
  pollMs: 30000, freshMs: 90000, tickSeconds: 2, maxConcurrent: 4,
  maxRepositories: 32, maxBackoffSeconds: 86400,
} as const;
