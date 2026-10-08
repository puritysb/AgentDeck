"""Contract cases grounded in pinned upstream observer-hooks.md (0a374d167)."""
import importlib.util
import json
import os
from types import SimpleNamespace
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).parents[1] / 'hermes-agentdeck' / '__init__.py'

class Context:
    def __init__(self): self.hooks = {}
    def register_hook(self, name, callback): self.hooks[name] = callback

class ObserverTests(unittest.TestCase):
    def setUp(self):
        # Minimal public Hermes host contract; the real Plugin Doctor is also
        # used separately against the installed upstream runtime.
        self.host = patch.dict('sys.modules', {'hermes_constants': SimpleNamespace(
            get_hermes_home=lambda: Path(os.environ.get('HERMES_HOME', '~/.hermes')).expanduser())})
        self.host.start()
        spec = importlib.util.spec_from_file_location('observer', SOURCE)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.ctx = Context()
        self.module.register(self.ctx)
        self.events = []
        self.patch = patch.object(self.module, '_post', lambda event, payload: self.events.append((event, payload)))
        self.patch.start()
    def tearDown(self):
        self.patch.stop()
        self.host.stop()
    def emit(self, name, **kwargs):
        self.assertIsNone(self.ctx.hooks[name](session_id='conversation-1', platform='cli', **kwargs))

    def test_captured_real_child_callbacks_export_only_one_parent_turn(self):
        capture = json.loads((SOURCE.parents[2] / 'bridge/src/__tests__/fixtures/hermes-live-child.json').read_text())
        for row in capture['callbacks']:
            self.assertIsNone(self.ctx.hooks[row['event']](**row['kwargs']))
        parent = self.module._identity('parent-conversation')
        self.assertEqual(len(self.events), len(capture['events']))
        for (event, payload), expected in zip(self.events, capture['events']):
            self.assertEqual(event, expected['event'])
            self.assertEqual(payload['session_id'], parent)
            actual = {k: v for k, v in payload.items() if k not in ('session_id', 'cwd', 'pid', 'tool_call_id', 'is_error')}
            wanted = {k: v for k, v in expected['payload'].items() if k not in ('session_id', 'cwd', 'pid', 'tool_call_id', 'is_error')}
            self.assertEqual(actual, wanted)
        self.assertEqual(sum(event == 'hermes_stop' for event, _ in self.events), 1)

    def test_two_turns_survive_run_end_and_finalize_once(self):
        self.emit('on_session_start')
        for i in range(2):
            self.emit('pre_llm_call', user_message='hello', model='model-x')
            self.emit('post_llm_call', assistant_response='hi')
            self.emit('on_session_end', completed=True, interrupted=False)
        self.emit('on_session_finalize')
        self.assertEqual([e for e, _ in self.events], ['hermes_session_start', 'hermes_user_prompt_submit', 'hermes_stop', 'hermes_user_prompt_submit', 'hermes_stop', 'hermes_session_end'])

    def test_interruption_stops_without_claiming_session_exit(self):
        self.emit('pre_llm_call')
        self.emit('on_session_end', completed=False, interrupted=True)
        self.assertEqual(self.events[-1][0], 'hermes_stop')
        self.assertTrue(self.events[-1][1]['interrupted'])

    def test_reset_closes_old_identity_not_new(self):
        self.emit('on_session_reset', old_session_id='old', new_session_id='conversation-1')
        self.assertEqual(self.events[0][1]['session_id'], self.module._identity('old'))
        self.events.clear()
        self.emit('on_session_reset')
        self.assertEqual(self.events, [])

    def test_profiles_are_distinct_and_private(self):
        with patch.dict('os.environ', {'HERMES_HOME': '/profile-a'}): a = self.module._identity('same')
        with patch.dict('os.environ', {'HERMES_HOME': '/profile-b'}): b = self.module._identity('same')
        self.assertNotEqual(a, b)
        self.assertNotIn('profile', a)

    def test_children_do_not_create_top_level_rows(self):
        self.emit('subagent_start', child_session_id='conversation-1')
        self.emit('pre_llm_call')
        self.assertEqual(self.events, [])

    def test_payload_is_allowlisted_and_bounded(self):
        self.emit('pre_tool_call', tool_name='memory', args={'secret': 'do-not-export'}, conversation_history=['private'])
        payload = self.events[-1][1]
        self.assertNotIn('args', payload)
        self.assertNotIn('conversation_history', payload)
        self.assertEqual(payload['tool_name'], 'memory')
        self.emit('pre_llm_call', user_message='x' * 10000)
        self.assertEqual(len(self.events[-1][1]['prompt']), 8192)

    def test_ci_evidence_is_normalized_private_and_matches_tool_end(self):
        secret = "private-api-token"
        args = {"command": "gh run watch 42 --repo example/project --interval 2", "background": True,
                "api_key": secret, "workdir": "/private/workspace"}
        self.emit('pre_tool_call', tool_name='terminal', args=args, tool_call_id=secret)
        start = self.events[-1][1]
        self.assertEqual(start['ci_wait_intent'], {"kind": "ci", "provider": "github-actions", "mode": "watch",
                                                 "runId": 42, "repo": "example/project"})
        self.assertTrue(start['ci_wait_background'])
        self.emit('post_tool_call', tool_name='terminal', args=args, tool_call_id=secret,
                  status='success', result={"secret": secret}, error_message=secret)
        end = self.events[-1][1]
        self.assertEqual(start['tool_call_id'], end['tool_call_id'])
        self.assertFalse(end['is_error'])
        self.assertNotIn(secret, json.dumps([start, end]))
        self.assertNotIn('command', start)
        self.assertNotIn('args', start)
        self.assertNotIn('result', end)
        self.assertNotIn('ci_wait_intent', end)

    def test_ci_commands_fail_closed_and_arguments_never_leak(self):
        for command in ('gh auth login --with-token', 'gh run watch 42; echo secret',
                        'TOKEN=secret gh run watch 42', 'gh run watch $(secret)',
                        'gh run watch 42 --repo secret=value', 'gh run watch',
                        'gh run watch 9007199254740992', 'gh pr checks 1',
                        'gh run watch 42 --unknown secret', 'gh run watch 42 | cat',
                        'gh run watch 42 > /private/log', 'x' * 16385):
            self.emit('pre_tool_call', tool_name='terminal', args={'command': command}, tool_call_id='a')
            payload = self.events[-1][1]
            self.assertNotIn('ci_wait_intent', payload, command)
            self.assertNotIn('args', payload)
            self.assertNotIn('tool_input', payload)
        self.emit('pre_tool_call', tool_name='memory', args={'command': 'gh run watch 42'}, tool_call_id='a')
        self.assertNotIn('ci_wait_intent', self.events[-1][1])

    def test_ci_pr_identity_and_explicit_background_boolean(self):
        for command, expected in (
            ('gh pr checks https://github.com/example/project/pull/4 --watch', {'repo': 'example/project', 'pr': 4}),
            ('gh --repo example/project pr checks topic/ci --watch', {'repo': 'example/project', 'ref': 'topic/ci'}),
            ('gh pr checks --watch', {}),
        ):
            self.emit('pre_tool_call', tool_name='terminal', args={'command': command, 'background': 1}, tool_call_id='a')
            payload = self.events[-1][1]
            self.assertEqual(payload['ci_wait_intent'], {"kind": "ci", "provider": "github-actions", "mode": "watch", **expected})
            self.assertFalse(payload['ci_wait_background'])
        self.emit('pre_tool_call', tool_name='terminal', args={'command': 'gh pr checks https://github.com/example/project/pull/4 --repo other/project --watch'}, tool_call_id='a')
        self.assertNotIn('ci_wait_intent', self.events[-1][1])

    def test_missing_tool_id_never_invents_a_ci_invocation(self):
        for value in (None, '', 'x' * 16385, 42):
            self.emit('pre_tool_call', tool_name='terminal', args={'command': 'gh run watch 42'}, tool_call_id=value)
            self.assertNotIn('tool_call_id', self.events[-1][1])
            self.assertNotIn('ci_wait_intent', self.events[-1][1])
        first = self.module._tool_id('one', 'same')
        self.assertNotEqual(first, self.module._tool_id('two', 'same'))

    def test_upstream_error_status_clears_wait_without_exporting_error_text(self):
        for status in ('error', 'blocked', 'cancelled', 'timeout', 'ok', None):
            self.emit('post_tool_call', tool_name='terminal', tool_call_id='a', status=status, error_message='secret')
            payload = self.events[-1][1]
            self.assertEqual(payload['is_error'], status in ('error', 'blocked', 'cancelled', 'timeout'))
            self.assertNotIn('secret', json.dumps(payload))

    def test_payload_names_the_hosting_process(self):
        # One-shot mode hard-exits without on_session_finalize; the daemon
        # closes the conversation when this pid is gone.
        self.emit('on_session_start')
        self.assertEqual(self.events[-1][1]['pid'], os.getpid())
        self.assertEqual(self.events[-1][1]['platform'], 'cli')
        self.assertEqual(self.events[-1][1]['project_name'], 'Hermes (cli)')

    def test_gateway_tools_without_platform_keep_conversation_context(self):
        # Observed in real API-server tool work on Hermes 0a374d167: only
        # session/turn callbacks carry platform; tool callbacks omit it.
        self.ctx.hooks['on_session_start'](session_id='gateway', platform='api_server')
        self.ctx.hooks['pre_tool_call'](session_id='gateway', tool_name='terminal')
        self.ctx.hooks['post_tool_call'](session_id='gateway', tool_name='terminal')
        for _, payload in self.events:
            self.assertEqual(payload['platform'], 'api_server')
            self.assertEqual(payload['project_name'], 'Hermes (api_server)')
            self.assertEqual(payload['cwd'], '')
        self.ctx.hooks['on_session_finalize'](session_id='gateway')
        self.assertEqual(self.module._CONTEXT, {})

    def test_orphan_tool_does_not_guess_cli_context(self):
        self.ctx.hooks['pre_tool_call'](session_id='unknown', tool_name='terminal')
        payload = self.events[-1][1]
        self.assertNotIn('platform', payload)
        self.assertNotIn('cwd', payload)
        self.assertNotIn('project_name', payload)

    def test_callback_exceptions_are_fail_open(self):
        with patch.object(self.module, '_handle', side_effect=RuntimeError('offline')):
            self.emit('pre_tool_call')

    def test_tracking_is_bounded(self):
        for i in range(600): self.module._remember(self.module._TURNS, str(i), True)
        self.assertEqual(len(self.module._TURNS), 512)
        for i in range(600): self.module._payload({'session_id': str(i), 'platform': 'api_server'})
        self.assertEqual(len(self.module._CONTEXT), 512)

    def test_final_response_waits_for_authoritative_outcome(self):
        self.emit('pre_llm_call')
        self.emit('post_llm_call', assistant_response='interrupted response')
        self.assertEqual(len(self.events), 1)
        self.emit('on_session_end', completed=False, interrupted=True)
        self.assertTrue(self.events[-1][1]['interrupted'])
        self.assertEqual(self.events[-1][1]['last_assistant_message'], 'interrupted response')

    def test_failed_run_is_aborted_not_user_interruption(self):
        self.emit('pre_llm_call')
        self.emit('on_session_end', completed=False, failed=True, interrupted=False)
        self.assertTrue(self.events[-1][1]['aborted'])
        self.assertFalse(self.events[-1][1]['interrupted'])

    def test_explicit_parent_suppresses_child_even_without_spawn_callback(self):
        self.emit('pre_llm_call', parent_session_id='parent')
        self.assertEqual(self.events, [])

    def test_queue_overflow_never_blocks(self):
        self.patch.stop()
        from unittest.mock import Mock
        self.module._WORKER = Mock()
        self.module._WORKER.is_alive.return_value = True
        for i in range(200): self.module._post('hermes_stop', {'session_id': str(i)})
        self.assertEqual(self.module._QUEUE.qsize(), 128)
        self.patch.start()

    def test_explicit_data_directory_never_falls_back_to_default(self):
        with tempfile.TemporaryDirectory() as home, patch.dict(os.environ, {"AGENTDECK_DATA_DIR": home}):
            with patch.object(self.module.Path, "home", side_effect=AssertionError("must not discover default daemon")):
                with self.assertRaises(FileNotFoundError):
                    self.module._deliver("hermes_session_start", {"session_id": "opaque"})

    def test_real_loopback_export_requires_receiver_capability(self):
        import threading
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        received = []
        supported = [False]
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self):
                body = json.dumps({'mode': 'daemon', 'hermesObserver': 1 if supported[0] else 0}).encode()
                self.send_response(200); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
            def do_POST(self):
                received.append((self.path, json.loads(self.rfile.read(int(self.headers['Content-Length'])))))
                self.send_response(200); self.send_header('Content-Length', '0'); self.end_headers()
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True); worker.start()
        try:
            with tempfile.TemporaryDirectory() as home, patch.dict(os.environ, {'AGENTDECK_DATA_DIR': ''}), patch.object(self.module.Path, 'home', return_value=Path(home)):
                registry = Path(home) / '.agentdeck'; registry.mkdir()
                (registry / 'daemon.json').write_text(json.dumps({'port': server.server_port}))
                self.module._deliver('hermes_session_start', {'session_id': 'opaque'})
                self.assertEqual(received, [])
                supported[0] = True
                self.module._deliver('hermes_session_start', {'session_id': 'opaque'})
                self.assertEqual(received, [('/hooks/hermes_session_start', {'session_id': 'opaque'})])
                with patch.dict(os.environ, {'AGENTDECK_DATA_DIR': str(registry)}):
                    with patch.object(self.module.Path, 'home', side_effect=AssertionError('explicit directory wins')):
                        self.module._deliver('hermes_stop', {'session_id': 'opaque'})
                self.assertEqual(received[-1][0], '/hooks/hermes_stop')
        finally:
            server.shutdown(); server.server_close(); worker.join(timeout=2)

if __name__ == '__main__': unittest.main()
