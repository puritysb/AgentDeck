"""AgentDeck session status and ambient light for the Vobot Mini Dock."""

import asyncio
import math
import time

import lvgl as lv
import peripherals

from .transport import Connection, PROFILE
from .palette import (
    ATTENTION_RGB, BACKGROUND_RGB, BORDER_RGB, CREATURES, CRITICAL_PERCENT,
    ERROR_RGB, HEALTH_RGB, IDLE_RGB, PANEL_RGB, PULSE_MS, SUBTEXT_RGB,
    TEXT_RGB, WARNING_PERCENT, WORKING_RGB,
)

from .usage import claude_rows, codex_age, codex_rows
from .pairing import connection_settings, settings_form

NAME = "AgentDeck"
ICON = "A:apps/" + NAME + "/resources/app-icon.png"

DARK_RGB = [(0, 0, 0)]
WAITING = ("awaiting_permission", "awaiting_option", "awaiting_diff")
LABELS = {
    "awaiting_permission": "PERM",
    "awaiting_option": "OPT",
    "awaiting_diff": "DIFF",
    "processing": "WORK",
    "idle": "IDLE",
    "disconnected": "OFF",
}
VISIBLE_ROWS = 6

_manager = None
_task = None
_motion_task = None
_screen = None
_status = None
_rows = []
_usage_rows = []
_image_agents = [None] * VISIBLE_ROWS
_claude_usage = {}
_codex_usage = {}
_usage_tick = None
_pulse_start = 0
_pulse_brightness = None
_light_owned = False
_light_waiting = None
_waiting_ids = []
_attention = None
_attention_session = None
_attention_agent = None
_attention_started = 0


async def on_boot(apm):
    global _manager
    _manager = apm


def get_settings_json():
    return settings_form()


def _light(waiting):
    global _light_owned, _light_waiting, _pulse_start, _pulse_brightness
    light = peripherals.ambient_light
    if not _light_owned:
        _light_owned = light.acquire()
    if _light_owned and _light_waiting != waiting:
        if light.set_color([ATTENTION_RGB] if waiting else DARK_RGB):
            _light_waiting = waiting
            if waiting:
                _pulse_start = time.ticks_ms()
                _pulse_brightness = None
                _animate_attention()


def _animate_attention():
    global _pulse_brightness
    if _light_owned and _light_waiting:
        elapsed = time.ticks_diff(time.ticks_ms(), _pulse_start) % PULSE_MS
        # Hold the peak longer so the rear strip reads in bright rooms.
        wave = math.cos(2 * math.pi * elapsed / PULSE_MS)
        brightness = min(100, int(88 + 30 * wave))
        if brightness != _pulse_brightness and peripherals.ambient_light.brightness(brightness):
            _pulse_brightness = brightness


def _release_light():
    global _light_owned, _light_waiting
    if _light_owned:
        peripherals.ambient_light.release()
    _light_owned = False
    _light_waiting = None


def _color(rgb):
    red, green, blue = rgb
    return lv.color_hex((red << 16) | (green << 8) | blue)


def _creature(agent):
    if agent in ("codex-cli", "codex-app"):
        return "codex"
    if agent in ("kiro-cli", "kiro-ide"):
        return "kiro"
    return agent if agent in CREATURES else None


def _show(status, rows=(), attention=False):
    _status.set_text(status)
    status_color = ATTENTION_RGB if attention else SUBTEXT_RGB
    _status.set_style_text_color(_color(status_color), 0)
    for index, cell in enumerate(_rows):
        tile, image, name_label, state_label = cell
        if index >= len(rows):
            tile.add_flag(lv.obj.FLAG.HIDDEN)
            continue
        tile.remove_flag(lv.obj.FLAG.HIDDEN)
        agent, name, state = rows[index]
        if agent:
            path = "A:apps/AgentDeck/resources/" + agent + ".png"
            if _image_agents[index] != agent:
                image.set_src(path)
                _image_agents[index] = agent
            image.remove_flag(lv.obj.FLAG.HIDDEN)
        else:
            image.add_flag(lv.obj.FLAG.HIDDEN)
        name_label.set_text(name)
        state_label.set_text(LABELS.get(state, "--"))
        color = ATTENTION_RGB if state in WAITING else WORKING_RGB if state == "processing" else SUBTEXT_RGB
        state_label.set_style_text_color(_color(color), 0)
        tile.set_style_border_color(_color(ATTENTION_RGB if state in WAITING else BORDER_RGB), 0)


def _session_name(row):
    name = row.get("displayName") or row.get("projectName") or "Session"
    return "".join(c if " " <= c <= "~" else "?" for c in name[:64])


def _waiting_sessions(live):
    # The daemon can reorder the roster as sessions update. Keep the order in
    # which this dock first saw each continuous wait, with roster order for ties.
    waiting = {}
    arriving = []
    for row in live:
        if row.get("state") in WAITING:
            key = row["id"]
            if key not in waiting:
                arriving.append(key)
            waiting[key] = row
    _waiting_ids[:] = [key for key in _waiting_ids if key in waiting]
    for key in arriving:
        if key not in _waiting_ids:
            _waiting_ids.append(key)
    return [waiting[key] for key in _waiting_ids]


def _show_sessions(sessions):
    live = [row for row in sessions if row.get("alive")]
    waiting = _waiting_sessions(live)
    others = [row for row in live if row.get("state") not in WAITING]
    lines = [
        (_creature(row.get("agentType")), _session_name(row), row.get("state"))
        for row in (waiting + others)[:VISIBLE_ROWS]
    ]
    if waiting:
        summary = "%d waiting / %d" % (len(waiting), len(live))
    elif len(live) > VISIBLE_ROWS:
        summary = "%d shown / %d" % (VISIBLE_ROWS, len(live))
    else:
        summary = "%d %s" % (len(live), "session" if len(live) == 1 else "sessions")
    _show(summary, lines, attention=bool(waiting))
    _show_attention(waiting[0] if waiting else None, len(waiting) - 1)
    _light(bool(waiting))


def _show_attention(row=None, extra=0):
    global _attention, _attention_session, _attention_agent, _attention_started
    if row is None:
        if _attention_session is not None:
            _attention[0].add_flag(lv.obj.FLAG.HIDDEN)
            _attention_session = None
        return
    if _attention is None:
        _attention = _new_attention_panel()
    panel, creature, fallback, name, status, more = _attention
    agent = _creature(row.get("agentType"))
    if agent != _attention_agent:
        if agent:
            creature.set_src("A:apps/AgentDeck/resources/" + agent + ".png")
        _attention_agent = agent
    if agent:
        creature.remove_flag(lv.obj.FLAG.HIDDEN)
        fallback.add_flag(lv.obj.FLAG.HIDDEN)
    else:
        creature.add_flag(lv.obj.FLAG.HIDDEN)
        fallback.remove_flag(lv.obj.FLAG.HIDDEN)
    name.set_text(_session_name(row))
    status.set_text({
        "awaiting_permission": "Approval needed",
        "awaiting_option": "Answer needed",
        "awaiting_diff": "Review needed",
    }[row["state"]])
    more.set_text("+%d" % extra if extra else "")
    if _attention_session != row["id"]:
        _attention_session = row["id"]
        _attention_started = time.ticks_ms()
        _animate_creature()
    panel.remove_flag(lv.obj.FLAG.HIDDEN)


def _reset_attention():
    _waiting_ids.clear()
    _show_attention()
    _release_light()


def _animate_creature():
    _, creature, fallback, _, _, _ = _attention
    elapsed = time.ticks_diff(time.ticks_ms(), _attention_started) % PULSE_MS
    lift = int(7 * math.sin(2 * math.pi * elapsed / PULSE_MS))
    if _attention_agent:
        creature.set_pos(136, 79 + lift)
    else:
        fallback.set_pos(0, 70 + lift)


async def _animate():
    while True:
        if _attention_session is not None:
            _animate_creature()
            _animate_attention()
        await asyncio.sleep_ms(60)


def _paint_usage(cells, readings):
    for index, (label, value, bar) in enumerate(cells):
        if index >= len(readings):
            label.set_width(130)
            label.set_text("No usage data" if index == 0 and not readings else "")
            value.set_text("")
            bar.add_flag(lv.obj.FLAG.HIDDEN)
            continue
        name, text, used, muted = readings[index]
        label.set_width(44 if used is not None else 62)
        label.set_text(name)
        value.set_text(text)
        value.set_style_text_color(_color(SUBTEXT_RGB if muted else TEXT_RGB), 0)
        if used is None:
            bar.add_flag(lv.obj.FLAG.HIDDEN)
            continue
        color = HEALTH_RGB
        if muted:
            color = IDLE_RGB
        elif used >= CRITICAL_PERCENT:
            color = ERROR_RGB
        elif used >= WARNING_PERCENT:
            color = ATTENTION_RGB
        bar.remove_flag(lv.obj.FLAG.HIDDEN)
        bar.set_value(int(used), lv.ANIM.OFF)
        bar.set_style_bg_color(_color(color), lv.PART.INDICATOR)


def _show_usage():
    global _usage_tick
    _usage_tick = time.ticks_ms()
    now = time.time()
    age = codex_age(_codex_usage, now)
    codex_readings = codex_rows(_codex_usage, now, muted=bool(age))
    _usage_rows[1][0].set_text(age if codex_readings else "")
    _paint_usage(_usage_rows[0][1], claude_rows(_claude_usage))
    _paint_usage(_usage_rows[1][1], codex_readings)


def _receive_usage(event):
    global _codex_usage
    if event.get("usageStale") or event.get("claudeUsageSnapshot"):
        _claude_usage.clear()
    for key in ("fiveHourPercent", "sevenDayPercent", "scopedLimits", "usageStale"):
        if key in event and (key == "usageStale" or not event.get("usageStale")):
            _claude_usage[key] = event.get(key)
    if "codexRateLimits" in event:
        _codex_usage = event.get("codexRateLimits") or {}
    _show_usage()


def _clear_usage():
    global _codex_usage
    _claude_usage.clear()
    _codex_usage = {}
    _show_usage()


async def _listen():
    try:
        settings = await connection_settings(_manager)
    except (OSError, ValueError, TypeError, asyncio.TimeoutError):
        _show("Pairing failed")
        return
    if settings is None:
        _show("Pair in App Settings")
        return
    while True:
        connection = Connection()
        try:
            await asyncio.wait_for(connection.connect(*settings), 5)
            start = time.ticks_ms()
            last_roster = start
            negotiated = False
            while True:
                event = await asyncio.wait_for(connection.receive(), 5 if not negotiated else 45)
                now = time.ticks_ms()
                if event and event.get("type") == "surface_welcome":
                    if (event.get("profile") != PROFILE or event.get("protocol") != 1
                            or "sessions.read" not in event.get("capabilities", ())):
                        raise ValueError("Wrong Surface profile")
                    negotiated = True
                    if "usage.read" in event["capabilities"]:
                        await asyncio.wait_for(connection.send(1, b'{"type":"query_usage"}'), 5)
                if negotiated and event and event.get("type") == "usage_update":
                    _receive_usage(event)
                if negotiated and event and event.get("type") == "sessions_list":
                    _show_sessions(event["sessions"])
                    last_roster = now
                if (not negotiated and time.ticks_diff(now, start) > 5000
                        or time.ticks_diff(now, last_roster) > 30000):
                    raise OSError("Stale session roster")
        except (OSError, EOFError, ValueError, KeyError, MemoryError, asyncio.TimeoutError):
            _show("Offline - reconnecting")
            _clear_usage()
            _reset_attention()
        except Exception as error:
            # Keep the pairing credential out of diagnostics.
            print("AgentDeck runtime error:", type(error).__name__)
            _show("Runtime error: " + type(error).__name__)
            _clear_usage()
            _reset_attention()
            return
        finally:
            await connection.close()
        await asyncio.sleep(3)


def _label(parent, x, y, font, rgb=TEXT_RGB):
    label = lv.label(parent)
    label.set_pos(x, y)
    label.set_style_text_font(font, 0)
    label.set_style_text_color(_color(rgb), 0)
    return label


def _panel(x, y, width, height):
    panel = lv.obj(_screen)
    panel.set_pos(x, y)
    panel.set_size(width, height)
    panel.set_style_pad_all(0, 0)
    panel.set_style_bg_color(_color(PANEL_RGB), 0)
    panel.set_style_border_width(1, 0)
    panel.set_style_border_color(_color(BORDER_RGB), 0)
    panel.set_style_radius(8, 0)
    panel.remove_flag(lv.obj.FLAG.SCROLLABLE)
    return panel


def _new_attention_panel():
    panel = _panel(0, 0, 320, 240)
    panel.add_flag(lv.obj.FLAG.HIDDEN)
    panel.set_style_radius(0, 0)
    panel.set_style_border_width(0, 0)
    panel.set_style_bg_color(_color(BACKGROUND_RGB), 0)
    title = _label(panel, 12, 12, lv.font_ascii_18, ATTENTION_RGB)
    title.set_text("WAITING FOR YOU")
    more = _label(panel, 236, 9, lv.font_ascii_bold_28, ATTENTION_RGB)
    more.set_width(72)
    more.set_style_text_align(lv.TEXT_ALIGN.RIGHT, 0)
    creature = lv.image(panel)
    creature.set_pivot(24, 24)
    creature.set_scale(768)  # LVGL's 256-unit scale: 48 px glyph → 144 px.
    fallback = _label(panel, 0, 70, lv.font_ascii_bold_48, ATTENTION_RGB)
    fallback.set_width(320)
    fallback.set_style_text_align(lv.TEXT_ALIGN.CENTER, 0)
    fallback.set_text("!")
    name = _label(panel, 12, 179, lv.font_ascii_bold_22)
    name.set_size(296, 28)
    name.set_style_text_align(lv.TEXT_ALIGN.CENTER, 0)
    name.set_long_mode(lv.label.LONG.DOT)
    status = _label(panel, 12, 210, lv.font_ascii_18, ATTENTION_RGB)
    status.set_width(296)
    status.set_style_text_align(lv.TEXT_ALIGN.CENTER, 0)
    return panel, creature, fallback, name, status, more


def _new_tile(x, y):
    tile = _panel(x, y, 98, 66)
    image = lv.image(tile)
    image.set_pos(3, 0)
    state = _label(tile, 51, 14, lv.font_ascii_14, SUBTEXT_RGB)
    name = _label(tile, 6, 48, lv.font_ascii_14)
    name.set_size(84, 16)
    name.set_long_mode(lv.label.LONG.DOT)
    return tile, image, name, state


def _new_usage_panel(x, title):
    panel = _panel(x, 171, 149, 65)
    _label(panel, 8, 2, lv.font_ascii_14).set_text(title)
    note = _label(panel, 70, 2, lv.font_ascii_14, SUBTEXT_RGB)
    note.set_width(69)
    note.set_text("")
    note.set_style_text_align(lv.TEXT_ALIGN.RIGHT, 0)
    cells = []
    for y in (17, 32, 47):
        label = _label(panel, 8, y, lv.font_ascii_14, SUBTEXT_RGB)
        label.set_size(81, 15)
        label.set_long_mode(lv.label.LONG.DOT)
        bar = lv.bar(panel)
        bar.set_pos(55, y + 6)
        bar.set_size(29, 4)
        bar.set_style_bg_color(_color(BORDER_RGB), 0)
        value = _label(panel, 73, y, lv.font_ascii_14)
        value.set_width(66)
        value.set_style_text_align(lv.TEXT_ALIGN.RIGHT, 0)
        cells.append((label, value, bar))
    return note, cells


async def on_start():
    global _screen, _status
    if _screen is None:
        _screen = lv.obj()
        _screen.set_style_bg_color(_color(BACKGROUND_RGB), 0)
        _screen.remove_flag(lv.obj.FLAG.SCROLLABLE)
        _label(_screen, 8, 1, lv.font_ascii_bold_28).set_text(NAME)
        _status = _label(_screen, 155, 9, lv.font_ascii_14, SUBTEXT_RGB)
        _status.set_width(157)
        _status.set_style_text_align(lv.TEXT_ALIGN.RIGHT, 0)
        for index in range(VISIBLE_ROWS):
            _rows.append(_new_tile(8 + (index % 3) * 103, 34 + (index // 3) * 68))
        _usage_rows.extend((_new_usage_panel(8, "Claude"), _new_usage_panel(162, "Codex")))
    _show("Connecting...")
    _clear_usage()
    lv.scr_load(_screen)
    if _manager:
        _manager.enter_root_page()
    await on_resume()


async def on_running_foreground():
    if _codex_usage and _usage_tick is not None and time.ticks_diff(time.ticks_ms(), _usage_tick) >= 10000:
        _show_usage()


async def on_resume():
    global _task, _motion_task
    if _task is None:
        _show("Connecting...")
        _task = asyncio.create_task(_listen())
        _motion_task = asyncio.create_task(_animate())


async def on_pause():
    global _task, _motion_task
    tasks = (_task, _motion_task)
    _task = _motion_task = None
    for task in tasks:
        if task is not None:
            task.cancel()
    _reset_attention()
    for task in tasks:
        if task is not None:
            try:
                await task
            except asyncio.CancelledError:
                pass


async def on_stop():
    await on_pause()
