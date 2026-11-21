"""Check that the dock follows the host display's sleep and dim instruction."""
import sys
import types
import unittest
from unittest.mock import patch

sys.modules.setdefault("lvgl", types.ModuleType("lvgl"))
sys.modules.setdefault("peripherals", types.ModuleType("peripherals"))

import AgentDeck as dock


class Screen:
    def __init__(self, level=70):
        self.level = level
        self.writes = []

    def brightness(self, value=None):
        if value is None:
            return self.level
        self.level = value
        self.writes.append(value)
        return True


class Blackout:
    def __init__(self):
        self.hidden = True
        self.raised = 0

    def add_flag(self, _):
        self.hidden = True

    def remove_flag(self, _):
        self.hidden = False

    def move_foreground(self):
        self.raised += 1


def state(on, **dim):
    event = {"type": "display_state", "displayOn": on}
    if dim:
        event["dim"] = dim
    return event


class DisplayTargetTests(unittest.TestCase):
    def test_maps_the_host_instruction(self):
        self.assertIsNone(dock._display_target(state(True)))
        self.assertIsNone(dock._display_target({"type": "display_state"}))
        self.assertEqual(dock._display_target(state(False)), 0)
        self.assertEqual(dock._display_target(state(False, enabled=True, mode="off", level=40)), 0)
        self.assertEqual(dock._display_target(state(False, enabled=True, mode="min", level=25)), 25)
        self.assertEqual(dock._display_target(state(False, mode="min", level=0)), 1)
        self.assertEqual(dock._display_target(state(False, mode="min")), 10)
        self.assertIsNone(dock._display_target(state(False, enabled=False, mode="off")))


class SetDarkTests(unittest.TestCase):
    def setUp(self):
        self.screen = Screen()
        self.blackout = Blackout()
        self.lights = []
        patches = (
            patch.object(dock, "_dark_target", None),
            patch.object(dock, "_saved_brightness", None),
            patch.object(dock, "_blackout", self.blackout),
            patch.object(dock, "_waiting_ids", []),
            patch.object(dock, "_release_light", lambda: self.lights.append("release")),
            patch.object(dock.peripherals, "screen", self.screen, create=True),
            patch.object(dock.lv, "obj", types.SimpleNamespace(FLAG=types.SimpleNamespace(HIDDEN=1)), create=True),
        )
        for item in patches:
            item.start()
            self.addCleanup(item.stop)

    def test_off_goes_black_and_wake_restores_the_user_level(self):
        dock._set_dark(0)
        self.assertEqual(self.screen.level, 0)
        self.assertFalse(self.blackout.hidden)
        self.assertEqual(self.lights, ["release"])
        dock._set_dark(None)
        self.assertEqual(self.screen.level, 70)
        self.assertTrue(self.blackout.hidden)
        self.assertIsNone(dock._saved_brightness)

    def test_resend_is_idempotent_and_level_change_applies_while_asleep(self):
        dock._set_dark(0)
        dock._set_dark(0)
        self.assertEqual(self.screen.writes, [0])
        dock._set_dark(20)
        self.assertEqual(self.screen.level, 20)
        self.assertTrue(self.blackout.hidden)
        dock._set_dark(None)
        # The level saved before the first dim wins, not the dimmed one.
        self.assertEqual(self.screen.level, 70)

    def test_missing_display_on_preserves_sleep_until_explicit_wake(self):
        for target, sleep_event in ((0, state(False)), (25, state(False, mode="min", level=25))):
            with self.subTest(target=target):
                self.screen.writes.clear()
                dock._set_dark(dock._display_target(sleep_event))
                for event in ({"type": "display_state"},
                              {"type": "display_state", "dim": {"enabled": False}}):
                    dock._set_dark(dock._display_target(event))
                    self.assertEqual(self.screen.writes, [target])
                    self.assertEqual(self.screen.level, target)
                    self.assertEqual(dock._dark_target, target)
                    self.assertEqual(dock._saved_brightness, 70)
                    self.assertEqual(self.blackout.hidden, target != 0)
                dock._set_dark(dock._display_target(state(True)))
                self.assertEqual(self.screen.writes, [target, 70])
                self.assertIsNone(dock._dark_target)
                self.assertTrue(self.blackout.hidden)

    def test_wake_relights_a_waiting_alert(self):
        dock._waiting_ids.append("s1")
        dock._set_dark(0)
        with patch.object(dock, "_light") as light:
            dock._set_dark(None)
        light.assert_called_once_with(True)

    def test_strip_stays_dark_while_host_sleeps(self):
        dock._set_dark(0)
        self.lights.clear()
        with patch.object(dock.peripherals, "ambient_light", create=True) as strip:
            dock._light(True)
        strip.acquire.assert_not_called()
        self.assertEqual(self.lights, ["release"])


if __name__ == "__main__":
    unittest.main()
