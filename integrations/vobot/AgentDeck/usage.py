"""Select quota readings for the two compact Mini Dock panels."""

import math
import time

from .palette import CODEX_AGED_SECONDS, CREDIT_UNITS


def _percent(value):
    if type(value) in (int, float) and math.isfinite(value) and value >= 0:
        return min(100, value)
    return None


def _timestamp(value):
    if not isinstance(value, str) or len(value) < 19:
        return None
    try:
        stamp = time.mktime((int(value[:4]), int(value[5:7]), int(value[8:10]),
                             int(value[11:13]), int(value[14:16]), int(value[17:19]),
                             0, 0, 0))
        offset = value[-6:]
        if len(offset) == 6 and offset[0] in "+-" and offset[3] == ":":
            seconds = (int(offset[1:3]) * 60 + int(offset[4:6])) * 60
            stamp += -seconds if offset[0] == "+" else seconds
        return stamp
    except (TypeError, ValueError, OverflowError):
        return None


def _window(row, now):
    if not row or row.get("stale"):
        return None
    reset = _timestamp(row.get("resetsAt"))
    if reset is not None and reset <= now:
        return None
    return _percent(row.get("usedPercent"))


def _duration(minutes, fallback):
    if type(minutes) is not int or minutes <= 0:
        return fallback
    if minutes % 1440 == 0:
        return "%dd" % (minutes // 1440)
    if minutes % 60 == 0:
        return "%dh" % (minutes // 60)
    return "%dm" % minutes


def _reading(label, used, muted=False, remaining=False):
    amount = 100 - used if remaining else used
    suffix = "% left" if remaining else "%"
    return label, str(int(amount)) + suffix, used, muted


def _credit_text(credits):
    if not credits:
        return None
    if credits.get("unlimited") is True:
        return "Unlimited"
    if credits.get("hasCredits") is False:
        return None
    try:
        balance = float(credits.get("balance"))
    except (ValueError, TypeError):
        return None
    if not math.isfinite(balance) or balance <= 0:
        return None
    for divisor, suffix in CREDIT_UNITS:
        if balance >= divisor:
            tenths = int(balance * 10 / divisor)
            whole, fraction = divmod(tenths, 10)
            return "%d.%d%s" % (whole, fraction, suffix) if fraction and whole < 100 else "%d%s" % (whole, suffix)
    if balance >= 10:
        return str(int(balance))
    tenths = int(balance * 10)
    whole, fraction = divmod(tenths, 10)
    if not tenths:
        return "<0.1"
    return "%d.%d" % (whole, fraction) if fraction else str(whole)


def claude_rows(usage):
    if usage.get("usageStale"):
        return []
    rows = []
    for label, key in (("5h", "fiveHourPercent"), ("7d", "sevenDayPercent")):
        used = _percent(usage.get(key))
        if used is not None:
            rows.append(_reading(label, used))
    # Reserve space for Fable when the account reports it. Other scoped limits
    # then follow the daemon's existing active-first, worst-first order.
    scoped = usage.get("scopedLimits") or ()
    fable = [item for item in scoped if "fable" in (item.get("label") or "").lower()]
    for item in fable + [item for item in scoped if item not in fable]:
        if len(rows) == 3:
            break
        label = item.get("label")
        used = _percent(item.get("percent"))
        if label and used is not None:
            rows.append(_reading("Fable" if item in fable else label, used))
    return rows


def codex_age(limits, now):
    captured = _timestamp(limits.get("capturedAt"))
    if captured is None or now - captured <= CODEX_AGED_SECONDS:
        return ""
    minutes = int((now - captured) // 60)
    if minutes < 60:
        return "%dm ago" % minutes
    if minutes < 1440:
        return "%dh ago" % (minutes // 60)
    return "%dd ago" % (minutes // 1440)


def codex_rows(limits, now, muted=False):
    windows = (limits.get("primary"), limits.get("secondary"))
    used = [_window(window, now) for window in windows]
    exhausted = any(value is not None and value >= 100 for value in used)
    rows = []
    credits = _credit_text(limits.get("credits"))
    if credits and (exhausted or not any(windows)):
        rows.append(("Credits", credits, None, muted))
    reserve = _window(limits.get("lunaReserve"), now)
    if exhausted and reserve is not None:
        rows.append(_reading("Luna", reserve, muted, remaining=True))
    if rows:
        return rows
    for index, (window, value) in enumerate(zip(windows, used)):
        if value is not None:
            label = _duration(window.get("windowMinutes"), ("Short", "Long")[index])
            rows.append(_reading(label, value, muted))
    return rows
