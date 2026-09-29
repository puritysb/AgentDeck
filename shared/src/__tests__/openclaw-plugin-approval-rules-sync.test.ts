// Drift gate for the OpenClaw plugin-approval SSOT mirror
// (shared/src/openclaw-plugin-approval.ts → Swift). A hand edit to the
// generated file, or a skipped `pnpm generate-openclaw-plugin-approval-rules`,
// fails here in CI. Sibling of openclaw-approval-rules-sync.test.ts.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as pluginApproval from '../openclaw-plugin-approval.js';
import {
  OUTPUTS,
  emitSwift,
  rulesFrom,
} from '../../../scripts/generate-openclaw-plugin-approval-rules.mjs';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const rules = rulesFrom(pluginApproval);

describe('generated mirror in sync', () => {
  for (const [rel, emit] of OUTPUTS) {
    it(`${rel} matches the SSOT`, () => {
      expect(readFileSync(`${repoRoot}${rel}`, 'utf8')).toBe(emit(rules));
    });
  }

  it('the default severity mirrors PLUGIN_APPROVAL_DEFAULT_SEVERITY, not a re-guessed literal', () => {
    const swift = emitSwift(rules);
    expect(swift).toContain(`let defaultSeverity = "${pluginApproval.PLUGIN_APPROVAL_DEFAULT_SEVERITY}"`);
    expect(pluginApproval.PLUGIN_APPROVAL_DEFAULT_SEVERITY).toBe('warning');
  });

  it('reuses ExecApprovalDecision rather than redeclaring the decision vocabulary', () => {
    // The whole point: exec already pins `allow` out of the union. A second,
    // independently-typed enum here is exactly the shape that let it back in
    // silently for one approval kind and not the other.
    const swift = emitSwift(rules);
    expect(swift).toContain('let decision: ExecApprovalDecision');
    expect(swift).not.toMatch(/enum PluginApprovalDecision/);
  });

  it('the Swift mirror reads the nested request, not flat fields', () => {
    const swift = emitSwift(rules);
    expect(swift).toContain('payload["request"] as? [String: Any]');
  });

  it('the Swift mirror has no unavailableDecisions subtraction — that axis does not exist on this surface', () => {
    expect(emitSwift(rules)).not.toContain('unavailableDecisions');
  });

  it('carries a defensive reader for plugin.approval.removed, undeclared in any .d.ts', () => {
    expect(emitSwift(rules)).toContain('static func removedId(from payload: [String: Any]) -> String?');
  });
});
