"""Contract cases grounded in upstream observer-hooks.md (16c59d0e)."""
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

    def test_callback_exceptions_are_fail_open(self):
        with patch.object(self.module, '_handle', side_effect=RuntimeError('offline')):
            self.emit('pre_tool_call')

    def test_tracking_is_bounded(self):
        for i in range(600): self.module._remember(self.module._TURNS, str(i), True)
        self.assertEqual(len(self.module._TURNS), 512)

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
            with tempfile.TemporaryDirectory() as home, patch.object(self.module.Path, 'home', return_value=Path(home)):
                registry = Path(home) / '.agentdeck'; registry.mkdir()
                (registry / 'daemon.json').write_text(json.dumps({'port': server.server_port}))
                self.module._deliver('hermes_session_start', {'session_id': 'opaque'})
                self.assertEqual(received, [])
                supported[0] = True
                self.module._deliver('hermes_session_start', {'session_id': 'opaque'})
                self.assertEqual(received, [('/hooks/hermes_session_start', {'session_id': 'opaque'})])
        finally:
            server.shutdown(); server.server_close(); worker.join(timeout=2)

if __name__ == '__main__': unittest.main()
