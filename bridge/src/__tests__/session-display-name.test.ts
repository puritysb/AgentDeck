import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeDisplayName, gitBranchDisplayName } from '../session-display-name.js';
import { parseClaudeTranscript } from '../passive-observer.js';

describe('Claude display-name sources (#544)', () => {
  it('uses measured user names, then matching titles, then derived/unknown names', () => {
    const file = {cwd:'/nonexistent', name:'Explicit', nameSource:'user'};
    expect(claudeDisplayName(file, 'Old')).toBe('Explicit');
    expect(claudeDisplayName({...file,nameSource:'derived'}, 'Title')).toBe('Title');
    expect(claudeDisplayName({...file,nameSource:'future'}, 'Title')).toBe('Title');
    expect(claudeDisplayName({...file,nameSource:'derived'})).toBe('Explicit');
    expect(claudeDisplayName({...file,name:''}, 'Old')).toBe('');
  });
  it('uses the last matching custom-title, ignores agent-name/foreign records and accepts clear', () => {
    const rows = [
      {type:'custom-title',sessionId:'a',customTitle:'First'},
      {type:'agent-name',sessionId:'a',agentName:'Not a session title'},
      {type:'custom-title',sessionId:'b',customTitle:'Foreign'},
      {type:'custom-title',sessionId:'a',customTitle:'Renamed'},
    ];
    const raw = rows.map(r=>JSON.stringify(r)).join('\n');
    expect(parseClaudeTranscript(raw,'a').customTitle).toBe('Renamed');
    expect(parseClaudeTranscript(raw).customTitle).toBeUndefined();
    expect(parseClaudeTranscript(raw+'\n'+JSON.stringify({type:'custom-title',sessionId:'a',customTitle:''}),'a').customTitle).toBe('');
  });
  it('reads branch changes and worktree pointers without invoking Git', () => {
    const dir = mkdtempSync(join(tmpdir(),'agentdeck-name-'));
    try {
      mkdirSync(join(dir,'.git')); mkdirSync(join(dir,'sub')); mkdirSync(join(dir,'worktree'));
      writeFileSync(join(dir,'.git','HEAD'),'ref: refs/heads/feature/labels\n');
      expect(gitBranchDisplayName(join(dir,'sub'))).toBe('feature/labels');
      writeFileSync(join(dir,'worktree','.git'),'gitdir: ../.git\n');
      expect(claudeDisplayName({cwd:join(dir,'worktree')})).toBe('feature/labels');
      writeFileSync(join(dir,'.git','HEAD'),'ref: refs/heads/renamed\n');
      expect(gitBranchDisplayName(dir)).toBe('renamed');
      writeFileSync(join(dir,'.git','HEAD'),'abcdef123456');
      expect(gitBranchDisplayName(dir)).toBe('');
    } finally { rmSync(dir,{recursive:true,force:true}); }
  });
});
