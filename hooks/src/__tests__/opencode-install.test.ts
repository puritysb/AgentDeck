import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import {
  installOpenCodeHooksIfNeeded,
  uninstallOpenCodeHooks,
  opencodePluginSource,
  opencodePluginPath,
  OPENCODE_PLUGIN_FILENAME,
} from '../opencode-install.js';

/**
 * Schema guard for the OpenCode observer plugin — the counterpart of
 * codex-install.test.ts. The plugin body is consumed by OpenCode's Bun
 * runtime and its POSTs by bridge/src/daemon-server.ts
 * `classifyObservedHookEvent`; these assertions pin the contract fields so
 * a refactor on either side fails loudly here instead of silently dropping
 * standalone OpenCode sessions from the timeline.
 */
describe('opencodePluginSource contract', () => {
  const src = opencodePluginSource();

  it('posts the four lifecycle events the daemon pipeline understands', () => {
    expect(src).toContain('opencode_session_start');
    expect(src).toContain('opencode_user_prompt_submit');
    expect(src).toContain('opencode_tool_start');
    expect(src).toContain('opencode_tool_end');
    expect(src).toContain('opencode_stop');
  });

  it('carries the payload fields the daemon reads', () => {
    // hookSid ← session_id; prompt → chat_start raw; response → chat_response.
    expect(src).toContain('session_id: sessionID');
    expect(src).toContain('prompt: prompt || ""');
    expect(src).toContain('last_assistant_message');
    expect(src).toContain('cwd');
  });

  it('self-disables inside managed agentdeck PTYs (AGENTDECK_PORT marker)', () => {
    expect(src).toContain('process.env.AGENTDECK_PORT');
    expect(src).toMatch(/if \(process\.env\.AGENTDECK_PORT\) return \{\};/);
  });

  it('resolves the daemon port from the canonical daemon.json candidates', () => {
    expect(src).toContain('.agentdeck", "daemon.json');
    expect(src).toContain('bound.serendipity.agent.deck');
    expect(src).toContain('9120');
    expect(src).toContain('/health');
  });

  it('bounds every network call (peer silence is a first-class signal)', () => {
    expect(src).toContain('AbortSignal.timeout(300)');
    expect(src).toContain('AbortSignal.timeout(800)');
  });

  it('separates user prompt parts from assistant response parts by messageID role', () => {
    expect(src).toContain('userMsgs');
    expect(src).toContain('responses.set');
  });
});

/**
 * Behavioural coverage — the contract tests above pin event *names*, but the
 * regression these guard is a *sequence*, so they run the real plugin body.
 * `client: null` keeps the steering long-poll loop from starting.
 */
describe('AgentDeckObserver event sequencing', () => {
  let dir: string | null = null;
  let posts: Array<{ event: string; body: Record<string, unknown> }> = [];

  beforeEach(() => {
    posts = [];
    delete process.env.AGENTDECK_PORT;
    vi.stubGlobal('fetch', async (url: unknown, init?: { body?: string }) => {
      const u = String(url);
      if (u.endsWith('/health')) return { ok: true };
      const hook = u.match(/\/hooks\/([a-z_]+)$/);
      if (hook && init?.body) {
        posts.push({ event: hook[1], body: JSON.parse(init.body) });
        return { ok: true };
      }
      return { ok: false };
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  /** Load a fresh copy of the plugin (module-level port cache resets per file). */
  async function observer(client: unknown = null) {
    dir = mkdtempSync(join(tmpdir(), 'agentdeck-oc-run-'));
    const file = join(dir, 'agentdeck.mjs');
    // Sequencing tests must not read the maintainer's real daemon/container files.
    writeFileSync(file, opencodePluginSource().replace(
      'import { readFile } from "node:fs/promises";',
      'const readFile = async () => { throw new Error("fixture: no registry"); };',
    ), 'utf-8');
    const mod = await import(pathToFileURL(file).href);
    return mod.AgentDeckObserver({ directory: '/tmp/proj', client });
  }

  /** post() is fire-and-forget through a promise chain — let it drain. */
  const flush = () => new Promise((r) => setTimeout(r, 20));

  const userMessage = {
    type: 'message.updated',
    properties: { info: { id: 'm1', sessionID: 's1', role: 'user', text: 'hi' } },
  };

  it('forwards bounded shell watch evidence with matching tool IDs and errors', async () => {
    const { event } = await observer();
    for (const status of ['pending', 'running', 'error']) {
      await event({ event: { type: 'message.part.updated', properties: { part: {
        type: 'tool', sessionID: 's1', callID: 'watch-1', tool: 'bash',
        state: { status, input: status === 'pending' ? undefined : { command: 'gh pr checks 460 --watch', secret: 'must-not-forward' } },
      } } } });
    }
    await flush();
    expect(posts.find(p => p.event === 'opencode_tool_start')?.body).toMatchObject({
      tool_use_id: 'watch-1', tool_input: { command: 'gh pr checks 460 --watch' },
    });
    expect(JSON.stringify(posts)).not.toContain('must-not-forward');
    expect(posts.find(p => p.event === 'opencode_tool_end')?.body).toMatchObject({ tool_use_id: 'watch-1', is_error: true });
  });

  it('forwards current permission and question request identities', async () => {
    const { event } = await observer();
    for (const wire of [
      { type: 'permission.asked', properties: { sessionID: 's1', id: 'p1', permission: 'bash' } },
      { type: 'permission.replied', properties: { sessionID: 's1', requestID: 'p1', reply: 'once' } },
      { type: 'question.asked', properties: { sessionID: 's1', id: 'q1', questions: [{ question: 'Which target?' }] } },
      { type: 'question.rejected', properties: { sessionID: 's1', requestID: 'q1' } },
    ]) await event({ event: wire });
    await flush();
    expect(posts.find(p => p.event === 'opencode_permission_asked')?.body).toMatchObject({ permission_id: 'p1', title: 'bash' });
    expect(posts.find(p => p.event === 'opencode_permission_replied')?.body).toMatchObject({ permission_id: 'p1' });
    expect(posts.find(p => p.event === 'opencode_question_asked')?.body).toMatchObject({ question_id: 'q1', title: 'Which target?' });
    expect(posts.find(p => p.event === 'opencode_question_rejected')?.body).toMatchObject({ question_id: 'q1' });
  });

  it('forwards legacy permission replies and header-only questions', async () => {
    const { event } = await observer();
    await event({ event: { type: 'permission.replied', properties: { sessionID: 's1', permissionID: 'legacy', response: 'once' } } });
    await event({ event: { type: 'question.asked', properties: { sessionID: 's1', id: 'q', questions: [{ header: 'Target' }] } } });
    await flush();
    expect(posts.find(p => p.event === 'opencode_permission_replied')?.body.permission_id).toBe('legacy');
    expect(posts.find(p => p.event === 'opencode_question_asked')?.body.title).toBe('Target');
  });

  it('keeps posting when every registry read is stuck awaiting OS access', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentdeck-oc-blocked-'));
    const file = join(dir, 'agentdeck.mjs');
    writeFileSync(file, opencodePluginSource().replace(
      'import { readFile } from "node:fs/promises";',
      'let reads = 0; const readFile = () => { if (++reads > 3) throw new Error("duplicate read"); return new Promise(() => {}); };',
    ), 'utf8');
    const mod = await import(pathToFileURL(file).href);
    const { event } = await mod.AgentDeckObserver({ directory: '/tmp/proj', client: null });
    await event({ event: userMessage });
    await new Promise((r) => setTimeout(r, 850));
    expect(posts.some((p) => p.event === 'opencode_user_prompt_submit')).toBe(true);
  });

  it('posts one user_prompt_submit per user message, including after the turn settles', async () => {
    const { event } = await observer();

    await event({ event: userMessage });
    await flush();
    await event({ event: { type: 'session.idle', properties: { sessionID: 's1' } } });
    await flush();
    // OpenCode re-emits message.updated for the settled user message. Before
    // the dedup entry survived session.idle this re-posted user_prompt_submit,
    // flipping the row back to processing and opening a phantom turn — with
    // no session.idle left to close it, the row read WORKING for 30 minutes.
    await event({ event: userMessage });
    await flush();

    expect(posts.filter((p) => p.event === 'opencode_user_prompt_submit')).toHaveLength(1);
    expect(posts.filter((p) => p.event === 'opencode_stop')).toHaveLength(1);
    // The daemon's last word on this session must be the stop.
    expect(posts[posts.length - 1].event).toBe('opencode_stop');
  });

  it('still reports a genuine second turn on a new user message', async () => {
    const { event } = await observer();

    await event({ event: userMessage });
    await flush();
    await event({ event: { type: 'session.idle', properties: { sessionID: 's1' } } });
    await flush();
    await event({
      event: {
        type: 'message.updated',
        properties: { info: { id: 'm2', sessionID: 's1', role: 'user', text: 'again' } },
      },
    });
    await flush();

    const submits = posts.filter((p) => p.event === 'opencode_user_prompt_submit');
    expect(submits).toHaveLength(2);
    expect(submits[1].body.prompt).toBe('again');
  });

  it('reports a Task-tool child session as the parent\'s subagent, never as a session', async () => {
    const { event } = await observer();
    await event({ event: userMessage });
    await event({ event: { type: 'session.created', properties: { info: { id: 'c1', parentID: 's1' } } } });
    await event({ event: { type: 'message.updated', properties: { info: { id: 'cm1', sessionID: 'c1', role: 'user', agent: 'explore', text: 'find the config' } } } });
    await event({ event: { type: 'message.updated', properties: { info: { id: 'cm2', sessionID: 'c1', role: 'assistant', agent: 'explore' } } } });
    await event({ event: { type: 'message.part.updated', properties: { part: {
      type: 'tool', sessionID: 'c1', callID: 'k1', tool: 'read', state: { status: 'running' },
    } } } });
    await event({ event: { type: 'message.part.updated', properties: { part: {
      type: 'text', sessionID: 'c1', messageID: 'cm2', text: 'found 3 files',
    } } } });
    await event({ event: { type: 'permission.asked', properties: { id: 'p1', sessionID: 'c1', permission: 'bash' } } });
    await event({ event: { type: 'session.idle', properties: { sessionID: 'c1' } } });
    await flush();
    const childPosts = posts.filter((p) => p.body.session_id === 'c1' || p.body.agent_id === 'c1');
    expect(childPosts.map((p) => p.event)).toEqual(['opencode_subagent_start', 'opencode_subagent_stop']);
    expect(childPosts[0].body).toMatchObject({ session_id: 's1', agent_id: 'c1', agent_type: 'explore' });
    expect(childPosts[1].body).toMatchObject({ session_id: 's1', last_assistant_message: 'found 3 files' });
    // A child's permission is a real wait: it lands on the parent's row.
    expect(posts.find((p) => p.event === 'opencode_permission_asked')?.body)
      .toMatchObject({ session_id: 's1', permission_id: 'p1' });
    expect(posts.some((p) => p.event === 'opencode_session_start' && p.body.session_id === 'c1')).toBe(false);
    expect(posts.some((p) => p.event === 'opencode_stop' && p.body.session_id === 'c1')).toBe(false);
  });

  it('asks the server for an unseen session\'s parent, and treats no answer as top level', async () => {
    const get = vi.fn(async ({ path }: { path: { id: string } }) => (
      path.id === 'c2' ? { data: { id: 'c2', parentID: 's9' } } : { data: { id: path.id } }
    ));
    const { event } = await observer({ session: { get } });
    await event({ event: { type: 'session.idle', properties: { sessionID: 'c2' } } });
    await flush();
    expect(posts.map((p) => p.event)).toEqual(['opencode_subagent_start', 'opencode_subagent_stop']);
    expect(posts[0].body).toMatchObject({ session_id: 's9', agent_id: 'c2' });
  });
});

describe('installOpenCodeHooksIfNeeded', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
    delete process.env.AGENTDECK_NO_OPENCODE_HOOKS;
  });

  const tmpPluginPath = () => {
    dir = mkdtempSync(join(tmpdir(), 'agentdeck-oc-'));
    return join(dir, 'plugins', OPENCODE_PLUGIN_FILENAME);
  };

  it('writes the plugin file (creating parent dirs) and is idempotent', () => {
    const path = tmpPluginPath();
    const first = installOpenCodeHooksIfNeeded({ pluginPath: path });
    expect(first.installed).toBe(true);
    expect(readFileSync(path, 'utf-8')).toBe(opencodePluginSource());

    const mtimeBefore = statSync(path).mtimeMs;
    const second = installOpenCodeHooksIfNeeded({ pluginPath: path });
    expect(second.installed).toBe(true);
    // Content unchanged → no rewrite.
    expect(statSync(path).mtimeMs).toBe(mtimeBefore);
  });

  it('refreshes a stale or edited plugin file', () => {
    const path = tmpPluginPath();
    installOpenCodeHooksIfNeeded({ pluginPath: path });
    writeFileSync(path, '// stale v0\n', 'utf-8');
    const result = installOpenCodeHooksIfNeeded({ pluginPath: path });
    expect(result.installed).toBe(true);
    expect(readFileSync(path, 'utf-8')).toBe(opencodePluginSource());
  });

  it('honours the AGENTDECK_NO_OPENCODE_HOOKS opt-out', () => {
    process.env.AGENTDECK_NO_OPENCODE_HOOKS = '1';
    const path = tmpPluginPath();
    const result = installOpenCodeHooksIfNeeded({ pluginPath: path });
    expect(result.installed).toBe(false);
    expect(result.reason).toContain('AGENTDECK_NO_OPENCODE_HOOKS');
    expect(existsSync(path)).toBe(false);
  });

  it('uninstall removes the plugin file and is idempotent', () => {
    const path = tmpPluginPath();
    installOpenCodeHooksIfNeeded({ pluginPath: path });
    uninstallOpenCodeHooks({ pluginPath: path });
    expect(existsSync(path)).toBe(false);
    uninstallOpenCodeHooks({ pluginPath: path }); // no throw
  });

  it('default path lives under the opencode plugins dir', () => {
    expect(opencodePluginPath()).toMatch(/opencode[\\/]+plugins[\\/]+agentdeck\.js$/);
  });
});
