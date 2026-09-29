import importlib.util
import logging
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('guard', Path(__file__).parents[1] / 'mlx-server-guard.py')
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

class Rejected(Exception):
    def __init__(self, **kwargs): self.status = kwargs['status_code']

class GuardTests(unittest.TestCase):
    def test_no_other_model_can_reach_loader_and_oom_exits(self):
        sentinel = object(); original = Mock(return_value='loaded')
        app = SimpleNamespace(_INHERIT_ADAPTER=sentinel, get_cached_model=original)
        server = SimpleNamespace(__version__='0.6.15', get_cached_model=original, _app_module=app)
        mx = Mock(); exit_process = Mock()
        handlers = logging.getLogger().handlers[:]
        try:
            with patch.dict(sys.modules, {'fastapi': SimpleNamespace(HTTPException=Rejected)}):
                loader = guard.install(server, 'gemma', 32 * 1024**3, mx, exit_process)
            self.assertEqual(loader('gemma'), 'loaded')
            for call in [lambda: loader('qwen'), lambda: app.get_cached_model('qwen'), lambda: loader('gemma', 'adapter'), lambda: loader('gemma', model_kind='embedding')]:
                with self.assertRaises(Rejected): call()
            self.assertEqual(original.call_count, 1)
            mx.set_memory_limit.assert_called_once_with(32 * 1024**3)
            error = RuntimeError('[METAL] Insufficient Memory')
            logging.error('Error in generation thread', exc_info=(RuntimeError, error, None))
            exit_process.assert_called_once_with(70)
        finally:
            logging.getLogger().handlers = handlers

    def test_budget_enforced_independently_of_soft_allocator_limit(self):
        mx = Mock(); mx.get_peak_memory.return_value = 33; exit_process = Mock()
        guard.enforce_budget(mx, 32, exit_process)
        exit_process.assert_called_once_with(70)

    def test_unknown_version_fails_before_installing(self):
        with self.assertRaises(RuntimeError): guard.install(SimpleNamespace(__version__='future'), 'gemma', 1, Mock())

if __name__ == '__main__': unittest.main()
