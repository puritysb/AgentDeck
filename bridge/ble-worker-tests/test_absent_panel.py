"""A panel that cannot be reached is not a daemon that has gone away.

Both BLE sync clients retry their panel inside their own loop and leave on their
own only once the daemon stops answering (BRIDGE_GONE_EXIT_SEC). That clock used
to advance only from fetches made while connected, so a switched-off panel made
the client exit as if the daemon had died, and the supervisor respawned it about
every 96 s (915 Timebox respawns in 24 h, measured 2026-10-18).

The clients import Pillow, bleak and the iDotMatrix library at module level, so
these tests stub them and need only the standard library.
"""
import asyncio
import contextlib
import importlib.util
import io
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

SRC = Path(__file__).resolve().parents[1] / 'src'
BRIDGE = 'http://127.0.0.1:9'
# The bridge-gone window is shrunk to this; each test runs for several of them.
GONE_SEC = 0.3
# The capped pause is longer than that window on purpose. In production the cap
# (30 s) equals the window, so a client that probed the daemon BEFORE pausing
# would let one capped pause run the clock out by itself.
BASE_PAUSE_SEC = 0.05
MAX_PAUSE_SEC = 0.4


class _Anything:
    def __init__(self, *args, **kwargs):
        pass


PIL_STUB = SimpleNamespace(Image=SimpleNamespace(Image=_Anything), ImageEnhance=SimpleNamespace())


class AbsentBleakClient:
    """bleak's client for a peripheral that is not advertising."""
    attempts = 0

    def __init__(self, address, timeout=None, disconnected_callback=None):
        self.address = address

    async def __aenter__(self):
        AbsentBleakClient.attempts += 1
        raise RuntimeError(f'Device with address {self.address} was not found')

    async def __aexit__(self, *exc):
        return False


class AbsentConnectionManager:
    """The iDotMatrix library's connection manager for a panel that is off."""
    attempts = 0

    def __init__(self):
        self.client = None

    async def connectByAddress(self, address):
        AbsentConnectionManager.attempts += 1
        raise RuntimeError(f'Device with address {address} was not found')

    async def disconnect(self):
        pass


def load_client(test, relative, stubs):
    patcher = patch.dict('sys.modules', stubs)
    patcher.start()
    test.addCleanup(patcher.stop)
    spec = importlib.util.spec_from_file_location(f'agentdeck_{Path(relative).stem}', SRC / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.BRIDGE_GONE_EXIT_SEC = GONE_SEC
    module.RECONNECT_BASE_SEC = BASE_PAUSE_SEC
    module.RECONNECT_MAX_SEC = MAX_PAUSE_SEC
    return module


def exits_within(coro_factory, seconds):
    """Run the client; True when it returned on its own within `seconds`."""
    async def scenario():
        task = asyncio.ensure_future(coro_factory())
        done, _ = await asyncio.wait({task}, timeout=seconds)
        if not done:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
            return False
        task.result()
        return True
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        return asyncio.run(scenario())


class TimeboxAbsentPanelTests(unittest.TestCase):
    def setUp(self):
        AbsentBleakClient.attempts = 0
        self.sync = load_client(self, 'timebox/sync_ble.py', {
            'PIL': PIL_STUB,
            'bleak': SimpleNamespace(BleakClient=AbsentBleakClient),
        })
        self.answering = True
        self.sync.bridge_reachable = lambda url, timeout=1.0: self.answering

    def run_client(self):
        return self.sync.run('7CF31CA8', BRIDGE, 100, 1.0, 1.0, 1.0)

    def test_keeps_retrying_an_absent_panel_while_the_daemon_answers(self):
        self.assertFalse(exits_within(self.run_client, 6 * GONE_SEC))
        self.assertGreaterEqual(AbsentBleakClient.attempts, 5)

    def test_still_exits_once_the_daemon_stops_answering(self):
        self.answering = False
        self.assertTrue(exits_within(self.run_client, 2.0))


class IDotMatrixAbsentPanelTests(unittest.TestCase):
    def setUp(self):
        AbsentConnectionManager.attempts = 0
        self.sync = load_client(self, 'idotmatrix/sync.py', {
            'PIL': PIL_STUB,
            'idotmatrix': SimpleNamespace(ConnectionManager=AbsentConnectionManager),
            'idotmatrix.modules': SimpleNamespace(),
            'idotmatrix.modules.image': SimpleNamespace(Image=_Anything),
            'idotmatrix.modules.common': SimpleNamespace(Common=_Anything),
        })
        self.answering = True
        self.sync._bridge_reachable_sync = lambda url: self.answering

    def run_client(self):
        return self.sync.run_sync('98A0BE6C', BRIDGE)

    def test_keeps_retrying_an_absent_panel_while_the_daemon_answers(self):
        self.assertFalse(exits_within(self.run_client, 6 * GONE_SEC))
        self.assertGreaterEqual(AbsentConnectionManager.attempts, 5)

    def test_still_exits_once_the_daemon_stops_answering(self):
        self.answering = False
        self.assertTrue(exits_within(self.run_client, 2.0))


class ReconnectBackoffTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('agentdeck_matrix_sync_common', SRC / 'pysync' / 'matrix_sync_common.py')
        self.common = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.common)

    def test_doubles_to_the_cap_and_starts_over_after_a_connection(self):
        backoff = self.common.ReconnectBackoff(3.0, 30.0)
        self.assertEqual([backoff.next_delay() for _ in range(6)], [3.0, 6.0, 12.0, 24.0, 30.0, 30.0])
        backoff.reset()
        self.assertEqual(backoff.next_delay(), 3.0)


if __name__ == '__main__':
    unittest.main()
