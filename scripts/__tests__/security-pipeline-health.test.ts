import { describe, expect, it } from 'vitest';
import { workflowHealth } from '../security-pipeline-health.mjs';

const now = Date.parse('2026-11-03T10:00:00Z');
const date = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();
const workflow = { path: '.github/workflows/security-scan.yml', state: 'active', created_at: date(2) };
const success = { id: 1, status: 'completed', conclusion: 'success', updated_at: date(1), created_at: date(1), html_url: 'https://github.com/fixture/run/1' };

describe('security pipeline freshness', () => {
  it('keeps an absent first scheduled run unverified despite a manual success', () => {
    expect(workflowHealth(workflow, [success], [], now).status).toBe('unverified');
  });
  it('fails when no scheduled run arrived before the startup deadline', () => {
    expect(workflowHealth({ ...workflow, created_at: date(27) }, [success], [], now).status).toBe('failed');
  });
  it('requires recent successful scheduled and general execution evidence', () => {
    expect(workflowHealth(workflow, [success], [success], now).status).toBe('healthy');
    expect(workflowHealth(workflow, [success], [{ ...success, updated_at: date(27) }], now).status).toBe('failed');
    expect(workflowHealth(workflow, [{ ...success, updated_at: date(27) }], [success], now).status).toBe('failed');
  });
  it('does not hide a failed scan behind an earlier success', () => {
    expect(workflowHealth(workflow, [{ ...success, id: 2, conclusion: 'failure' }, success], [success], now).status).toBe('failed');
  });
  it('fails closed for disabled workflows, invalid evidence and stuck execution', () => {
    expect(workflowHealth({ ...workflow, state: 'disabled_manually' }, [success], [success], now).status).toBe('failed');
    expect(() => workflowHealth(workflow, [success], [{ ...success, updated_at: 'invalid' }], now)).toThrow();
    expect(workflowHealth(workflow, [{ ...success, id: 2, status: 'in_progress', created_at: date(2) }, success], [success], now).status).toBe('failed');
  });
});
