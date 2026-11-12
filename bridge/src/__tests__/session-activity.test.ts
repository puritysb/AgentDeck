import { describe, expect, it } from 'vitest';
import { quickActivity } from '../session-activity.js';
import type { EnrichedSession } from '../session-aggregator.js';

const session = (currentTask: string): EnrichedSession =>
  ({ id: 's', port: 0, alive: true, projectName: 'demo', state: 'processing', currentTask }) as EnrichedSession;

describe('quickActivity', () => {
  it('names the file or script a tool is acting on', () => {
    expect(quickActivity(session('Edit /repo/src/auth.ts'))).toBe('Editing auth.ts');
    expect(quickActivity(session('Bash /repo/scripts/build.sh --release'))).toBe('Running build.sh');
    expect(quickActivity(session('Bash pnpm test'))).toBe('Running pnpm test');
  });

  it('never shows a session id fragment as the thing being run', () => {
    // Seen on the Android tablet as "Running b38d07d7-46db-431d-b0": the
    // observer cuts the argument at 80 characters, inside the scratchpad
    // path's session-id directory.
    const command = '/private/tmp/claude-501/-Users-someone-github-AgentDeck/b38d07d7-46db-431d-b00b-73be6ea38163/scratchpad/run.sh';
    expect(quickActivity(session(`Bash ${command.slice(0, 80)}`))).toBe('Running');
    expect(quickActivity(session('Bash /tmp/work/b38d07d7-46db-431d-b00b-73be6ea38163'))).toBe('Running');
    expect(quickActivity(session('Read /cache/9f86d081884c7d659a2feaa0c55ad015'))).toBe('Reading');
    // The full path still ends in a readable name.
    expect(quickActivity(session(`Bash ${command}`))).toBe('Running run.sh');
    // A short hex-looking name is a name.
    expect(quickActivity(session('Read /repo/cafe'))).toBe('Reading cafe');
  });
});
