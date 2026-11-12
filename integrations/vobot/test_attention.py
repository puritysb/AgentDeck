"""Check how roster updates enter, change, and leave the dock's alert."""
import sys
import types
import unittest
from unittest.mock import patch

sys.modules.setdefault("lvgl", types.ModuleType("lvgl"))
sys.modules.setdefault("peripherals", types.ModuleType("peripherals"))

import AgentDeck as dock


class Widget:
    def __init__(self):
        self.hidden = True
        self.text = ""
        self.position = None
        self.source = None

    def add_flag(self, _):
        self.hidden = True

    def remove_flag(self, _):
        self.hidden = False

    def set_text(self, value):
        self.text = value

    def set_src(self, value):
        self.source = value

    def set_pos(self, x, y):
        self.position = (x, y)


def session(key, name, agent, state="awaiting_option"):
    return dict(id=key, projectName=name, agentType=agent, state=state, alive=True)


class AttentionTests(unittest.TestCase):
    def setUp(self):
        self.widgets = [Widget() for _ in range(6)]
        self.tick = 0
        patches = (
            patch.object(dock, "_attention", None),
            patch.object(dock, "_attention_session", None),
            patch.object(dock, "_attention_agent", None),
            patch.object(dock, "_waiting_ids", []),
            patch.object(dock, "_new_attention_panel", return_value=self.widgets),
            patch.object(dock, "_show"),
            patch.object(dock, "_light"),
            patch.object(dock, "_release_light"),
            patch.object(dock.lv, "obj", types.SimpleNamespace(FLAG=types.SimpleNamespace(HIDDEN=1)), create=True),
            patch.object(dock.time, "ticks_ms", lambda: self.tick, create=True),
            patch.object(dock.time, "ticks_diff", lambda a, b: a - b, create=True),
        )
        for item in patches:
            item.start()
            self.addCleanup(item.stop)

    def test_reordered_roster_keeps_first_wait_and_advances_after_answer(self):
        first = session("b", "First", "codex-app")
        second = session("a", "Second", "claude-code", "awaiting_permission")
        panel, creature, _, name, status, extra = self.widgets
        dock._show_sessions([first])
        self.assertFalse(panel.hidden)
        self.assertTrue(creature.source.endswith("/codex.png"))
        initial_position = creature.position

        self.tick = 275
        dock._show_sessions([second, first])
        self.assertEqual((name.text, status.text, extra.text), ("First", "Answer needed", "+1"))
        dock._animate_creature()
        self.assertNotEqual(creature.position, initial_position)

        first["state"] = "processing"
        dock._show_sessions([first, second])
        self.assertEqual((name.text, status.text, extra.text), ("Second", "Approval needed", ""))
        self.assertTrue(creature.source.endswith("/claude-code.png"))

        first["state"] = "awaiting_diff"
        dock._show_sessions([first, second])
        self.assertEqual((name.text, extra.text), ("Second", "+1"))
        second["alive"] = False
        dock._show_sessions([second, first])
        self.assertEqual((name.text, status.text, extra.text), ("First", "Review needed", ""))

        first["state"] = "idle"
        dock._show_sessions([first, second])
        self.assertTrue(panel.hidden)
        dock._light.assert_called_with(False)
        self.assertEqual(dock._show.call_args.args[0], "1 session")

    def test_disconnect_clears_order_and_releases_light(self):
        first = session("a", "First", "codex")
        second = session("b", "Second", "unknown")
        dock._show_sessions([first, second])
        dock._reset_attention()
        self.assertTrue(self.widgets[0].hidden)
        dock._release_light.assert_called_once()

        dock._show_sessions([second, first])
        panel, creature, fallback, name, _, extra = self.widgets
        self.assertFalse(panel.hidden)
        self.assertTrue(creature.hidden)
        self.assertFalse(fallback.hidden)
        self.assertEqual((name.text, extra.text), ("Second", "+1"))


if __name__ == "__main__":
    unittest.main()
