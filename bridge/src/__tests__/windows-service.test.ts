/**
 * Unit tests for the Windows Scheduled Task XML builder (pure, cross-platform).
 *
 * The schtasks /Create|/Run|/Query|/Delete calls in windows-service.ts are
 * integration-only — they require a real Windows host and mutate the Task
 * Scheduler — and are exercised manually per docs/daemon.md, not here.
 */
import { describe, it, expect } from 'vitest';
import {
  TASK_NAME,
  xmlEscape,
  buildScheduledTaskXml,
} from '../windows-service.js';

describe('xmlEscape', () => {
  it('escapes XML metacharacters', () => {
    expect(xmlEscape('a & b < c > d "e"')).toBe('a &amp; b &lt; c &gt; d &quot;e&quot;');
  });
});

describe('buildScheduledTaskXml', () => {
  const node = 'C:\\Program Files\\nodejs\\node.exe';
  const cliJs = 'C:\\Users\\Test User\\AppData\\agentdeck\\cli.js';

  it('produces a well-formed v1.2 task with a logon trigger', () => {
    const xml = buildScheduledTaskXml({ node, cliJs, user: 'CORP\\alice' });
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-16"?>');
    expect(xml).toContain('<Task version="1.2"');
    expect(xml).toContain('<LogonTrigger>');
    expect(xml).toContain(`<URI>\\${TASK_NAME}</URI>`);
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>');
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>');
  });

  it('mirrors LaunchAgent KeepAlive / no-stop semantics', () => {
    const xml = buildScheduledTaskXml({ node, cliJs });
    expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
    expect(xml).toContain('<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>');
    expect(xml).toContain('<StopOnIdleEnd>false</StopOnIdleEnd>');
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
    expect(xml).toMatch(/<RestartOnFailure>\s*<Interval>PT1M<\/Interval>\s*<Count>3<\/Count>/);
  });

  it('uses node as unquoted Command and quotes the cli.js path in Arguments', () => {
    const xml = buildScheduledTaskXml({ node, cliJs });
    expect(xml).toContain(`<Command>${node}</Command>`);
    // cli.js path has a space — must be wrapped in quotes inside Arguments.
    expect(xml).toContain(`<Arguments>&quot;${cliJs}&quot; daemon start --foreground</Arguments>`);
  });

  it('XML-escapes special characters in the user id and paths', () => {
    const xml = buildScheduledTaskXml({
      node: 'C:\\n&ode.exe',
      cliJs: 'C:\\c<li>.js',
      user: 'DOM&AIN\\b<ob>',
    });
    expect(xml).toContain('<Command>C:\\n&amp;ode.exe</Command>');
    expect(xml).toContain('c&lt;li&gt;.js');
    expect(xml).not.toMatch(/<UserId>[^<]*&(?!amp;|lt;|gt;|quot;)/);
    expect(xml).toContain('DOM&amp;AIN\\b&lt;ob&gt;');
  });

  it('places both UserId fields (trigger + principal) with the same user', () => {
    const xml = buildScheduledTaskXml({ node, cliJs, user: 'CORP\\alice' });
    const matches = xml.match(/<UserId>CORP\\alice<\/UserId>/g);
    expect(matches).toHaveLength(2);
  });
});
