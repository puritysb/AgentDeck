// Drift gate for the generated APME work-display mirrors
// (task title + action fold + task gradeability → Swift). A hand edit
// to either generated file, or a skipped `pnpm generate-apme-display-rules`,
// fails here in CI — the pairing-code-rules sync-test pattern. This replaces
// the former task-title-swift-sync.test.ts constants grep: the title/fold
// constants now ride the emitters, so a one-sided tune is a byte diff.
//
// The BEHAVIOR of the mirrors stays pinned by the shared vector files
// (task-title-vectors.json / action-fold-vectors.json), which both suites
// replay — a byte-identical mirror emitted from wrong rules goes red there.
//
// The idle-gap boundary is still a hand-mirrored constant in
// ApmeCollector.swift (a task-segmentation rule both daemons must enforce at
// the same instant), so its grep gate stays here.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as taskTitle from '../task-title.js';
import * as actionFold from '../action-fold.js';
import * as comparison from '../apme-comparison.js';
import * as scorecard from '../apme-scorecard-sql.js';
import * as taskGradeability from '../../../bridge/src/apme/task-gradeability.js';
import { OUTPUTS, rulesFrom } from '../../../scripts/generate-apme-display-rules.mjs';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const rules = rulesFrom(taskTitle, actionFold, taskGradeability, comparison, scorecard);

describe('APME comparison eligibility', () => {
  const vectors = JSON.parse(readFileSync(`${repoRoot}shared/apme-comparison-vectors.json`, 'utf8'));
  for (const v of vectors) {
    it(`keeps ${JSON.stringify(v)} consistent`, () => {
      expect(comparison.isApmeComparisonEligible(v.model, v.category, v.samples)).toBe(v.eligible);
    });
  }
});

describe('generated APME display-rule mirrors in sync', () => {
  for (const [rel, emit] of OUTPUTS) {
    it(`${rel} matches the SSOT`, () => {
      const onDisk = readFileSync(`${repoRoot}${rel}`, 'utf8');
      expect(onDisk).toBe(emit(rules));
    });
  }

  it('emitters embed the SSOT constants (sanity on the emitters themselves)', () => {
    const [titleOut, foldOut, gradeabilityOut] = OUTPUTS;
    const swiftTitle = titleOut[1](rules);
    const swiftFold = foldOut[1](rules);
    expect(swiftTitle).toContain(`static let maxChars = ${taskTitle.TASK_TITLE_MAX_CHARS}`);
    expect(swiftTitle).toContain(`static let minChars = ${taskTitle.TASK_TITLE_MIN_CHARS}`);
    expect(swiftFold).toContain(`static let maxTools = ${actionFold.ACTION_FOLD_MAX_TOOLS}`);
    for (const name of actionFold.DISPATCH_TOOL_NAMES) {
      expect(swiftFold).toContain(JSON.stringify(name));
    }
    for (const name of actionFold.MESSAGING_TOOL_NAMES) {
      expect(swiftFold).toContain(JSON.stringify(name));
    }
    const swiftGradeability = gradeabilityOut[1](rules);
    expect(swiftGradeability).toContain(
      `static let workEvidenceMinToolCalls = ${taskGradeability.WORK_EVIDENCE_MIN_TOOL_CALLS}`,
    );
    expect(swiftGradeability).toContain(
      `static let trivialPromptMaxChars = ${taskGradeability.TRIVIAL_PROMPT_MAX_CHARS}`,
    );
    expect(swiftGradeability).toContain(
      `static let trivialReplyMaxChars = ${taskGradeability.TRIVIAL_REPLY_MAX_CHARS}`,
    );
  });

  it('the Swift suite replays all shared vector files (grep the test wiring)', () => {
    const swiftTest = readFileSync(
      `${repoRoot}apple/AgentDeckTests/ApmeTaskBoundaryTests.swift`, 'utf8');
    expect(swiftTest).toContain('shared/task-title-vectors.json');
    expect(swiftTest).toContain('shared/action-fold-vectors.json');
    expect(swiftTest).toContain('shared/task-gradeability-vectors.json');
  });
});

describe('Swift daemon still mirrors the hand-pinned APME constants', () => {
  it('idle-gap boundary matches AGENT_IDLE_GAP_MS (Swift keeps seconds)', async () => {
    const { AGENT_IDLE_GAP_MS } = await import('../eval-schema.js');
    const swift = readFileSync(
      `${repoRoot}apple/AgentDeck/Daemon/Apme/ApmeCollector.swift`, 'utf8');
    expect(swift).toContain(`var idleGapSec: TimeInterval = ${AGENT_IDLE_GAP_MS / 1000}`);
  });

  // The Work-board attention bucket is a cross-daemon contract: the same
  // task must land in the same bucket whichever daemon owns port 9120. The
  // SQL text lives per-side (SQLite dialects match, drivers differ), so the
  // NUMBERS are pinned here against the shared SSOT the Node store imports.
  it('attention window and red band match the eval-schema SSOT', async () => {
    const { TASK_ATTENTION_WINDOW_MS, TASK_ATTENTION_RED_SCORE } =
      await import('../eval-schema.js');
    const swift = readFileSync(
      `${repoRoot}apple/AgentDeck/Daemon/Apme/ApmeStore.swift`, 'utf8');
    expect(TASK_ATTENTION_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(swift).toContain('static let taskAttentionWindowMs = 7 * 24 * 60 * 60 * 1000');
    expect(swift).toContain(`static let taskAttentionRedScore = ${TASK_ATTENTION_RED_SCORE}`);
    // The `_empty` bookkeeping-shell filter must exist on both sides too.
    expect(swift).toContain(`!= '_empty'`);
  });
});
