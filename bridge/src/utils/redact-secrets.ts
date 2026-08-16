/** Redact common credential prefixes before agent-authored text reaches UI. */
export function redactSecrets(value: string): string {
  const patterns = [
    'sk-ant-',
    'sk-proj-',
    'sk-or-',
    'sk_live_',
    'sk_test_',
    'ghp_',
    'github_pat_',
    'glpat-',
    'xoxb-',
    'xoxp-',
    'Bearer ',
  ];
  let result = value;
  for (const pattern of patterns) {
    let idx = result.indexOf(pattern);
    while (idx >= 0) {
      const tokenStart = idx + pattern.length;
      const endOffset = result.slice(tokenStart).search(/\s/);
      const end = endOffset >= 0 ? tokenStart + endOffset : result.length;
      result = `${result.slice(0, idx)}[REDACTED]${result.slice(end)}`;
      idx = result.indexOf(pattern, idx + '[REDACTED]'.length);
    }
  }
  return result;
}
