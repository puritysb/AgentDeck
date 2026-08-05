/**
 * APME types — re-export of the canonical AgentDeck eval v1 schema.
 *
 * The source-of-truth lives in `@agentdeck/shared` (`shared/src/eval-schema.ts`)
 * so external consumers and other packages can pin to the same wire format.
 * Bridge code keeps importing from `./types.js` for ergonomics; this file is
 * a thin alias and intentionally has no original definitions.
 */

export type {
  ApmeRunRow,
  ApmeStepRow,
  ApmeArtifactRow,
  ApmeEvalRowDb,
  ApmeEvalLayer,
  ApmeRubricRow,
  ApmeVibeRow,
  ApmeScorecardRow,
  ApmeCategoryScorecardRow,
  ApmeTaskRow,
  ApmeTaskListRow,
  TaskBoundarySignal,
  ParsedJudge,
  ResponseKind,
  EvalSchemaVersion,
} from '@agentdeck/shared';

export { EVAL_SCHEMA_VERSION } from '@agentdeck/shared';
