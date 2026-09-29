import { MatrixExpression, type MatrixSession, type MatrixResult } from '@agentdeck/shared';
import { renderMatrixScene } from './matrix-art.js';
export { deskSignal } from '@agentdeck/shared';
/** Stateless preview compatibility. Live surfaces retain one MatrixExpression
 * per daemon/module and ingest events so previews cannot trigger entrances. */
export function renderDeskAwareness(size: 11 | 32, sessions: MatrixSession[] | null,
  timeline: MatrixResult[], now: number): Uint8Array {
  const expression = new MatrixExpression();
  if (sessions !== null) expression.updateSessions(sessions, now);
  expression.updateTimeline(timeline);
  return renderMatrixScene(size, expression.scene(now));
}
