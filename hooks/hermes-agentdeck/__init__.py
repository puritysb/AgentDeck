"""AgentDeck Hermes observer v1. No hook changes Hermes execution.

Contract: NousResearch/hermes-agent@16c59d0e, hermes.observer.v1.
Network work is serialized by one bounded daemon worker, never in a callback.
Only an AgentDeck daemon advertising hermesObserver is eligible (older/native
receivers must not misclassify these hooks as Claude). No default-port probing.
"""
import atexit
import hashlib
import json
import os
from pathlib import Path
import queue
import threading
import time
import urllib.request
from collections import OrderedDict
from hermes_constants import get_hermes_home

_QUEUE = queue.Queue(maxsize=128)
_LOCK = threading.RLock()
_WORKER = None
_CHILDREN = OrderedDict()
_TURNS = OrderedDict()
_MAX_TRACKED = 512
# Ignore proxy env vars and redirects: observation must stay on loopback.
class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

_HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())


def _identity(sid):
    if not isinstance(sid, str) or not sid.strip():
        return None
    home = str(get_hermes_home().expanduser().resolve())
    return "hermes-" + hashlib.sha256((home + "\0" + sid).encode()).hexdigest()[:32]


def _remember(mapping, key, value):
    mapping[key] = value
    mapping.move_to_end(key)
    while len(mapping) > _MAX_TRACKED:
        mapping.popitem(last=False)


def _text(value, limit=8192):
    return value[:limit] if isinstance(value, str) else ""


def _payload(kwargs, sid=None):
    if kwargs.get("parent_session_id"):
        return None
    identity = _identity(sid or kwargs.get("session_id"))
    if not identity or identity in _CHILDREN:
        return None
    platform = _text(kwargs.get("platform"), 40) or "CLI"
    return {
        "session_id": identity,
        "cwd": os.getcwd() if platform.lower() == "cli" else "",
        "project_name": "Hermes · " + platform,
        "model": _text(kwargs.get("model"), 200),
    }


def _deliver(event, payload):
    # Resolve every delivery: a daemon restart can move the port.
    registry = Path.home() / ".agentdeck" / "daemon.json"
    info = json.loads(registry.read_text())
    port = info.get("httpPort") or info.get("port")
    if type(port) is not int or not 1 <= port <= 65535:
        return
    base = "http://127.0.0.1:" + str(port)
    with _HTTP.open(base + "/health", timeout=0.2) as response:
        health = json.loads(response.read(65536))
    if health.get("mode") != "daemon" or health.get("hermesObserver") != 1:
        return
    request = urllib.request.Request(
        base + "/hooks/" + event,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"}, method="POST",
    )
    with _HTTP.open(request, timeout=0.8) as response:
        response.read(1024)


def _run():
    while True:
        created, event, payload = _QUEUE.get()
        try:
            # A congested/dead daemon must not replay old working states later.
            if time.monotonic() - created < 5:
                _deliver(event, payload)
        except Exception:
            pass  # Observation never breaks Hermes or retries an old turn.
        finally:
            _QUEUE.task_done()


def _flush():
    # CLI teardown may exit immediately after finalize. Give the worker one
    # bounded second; never keep a broken daemon holding Hermes open.
    deadline = time.monotonic() + 1.0
    while _QUEUE.unfinished_tasks and time.monotonic() < deadline:
        time.sleep(0.01)


def _post(event, payload):
    global _WORKER
    if payload is None or os.environ.get("AGENTDECK_NO_HERMES_HOOKS") == "1":
        return
    with _LOCK:
        if _WORKER is None or not _WORKER.is_alive():
            _WORKER = threading.Thread(target=_run, name="agentdeck-observer", daemon=True)
            _WORKER.start()
            atexit.register(_flush)
        try:
            _QUEUE.put_nowait((time.monotonic(), event, payload))
        except queue.Full:
            pass  # Bounded best effort; daemon expires abandoned state.


def _handle(event, **kwargs):
    # Serialize concurrent callbacks too. A callback has no network I/O and
    # always returns None (pre_llm/pre_tool return values can change behavior).
    with _LOCK:
        if event == "subagent_start":
            child = _identity(kwargs.get("child_session_id"))
            if child:
                _remember(_CHILDREN, child, True)
            return
        if event == "on_session_reset":
            # Gateway reset carries NEW session_id; only old_session_id may
            # close a row here. CLI already emits finalize for the old one.
            old = kwargs.get("old_session_id")
            if old:
                _post("hermes_session_end", _payload(kwargs, old))
            return
        payload = _payload(kwargs)
        if payload is None:
            return
        sid = payload["session_id"]
        if event == "on_session_start":
            _post("hermes_session_start", payload)
        elif event == "pre_llm_call":
            _remember(_TURNS, sid, {"response": ""})
            payload["prompt"] = _text(kwargs.get("user_message"))
            _post("hermes_user_prompt_submit", payload)
        elif event in ("pre_tool_call", "post_tool_call"):
            payload["tool_name"] = _text(kwargs.get("tool_name"), 120)
            _post("hermes_tool_start" if event == "pre_tool_call" else "hermes_tool_end", payload)
        elif event == "post_llm_call":
            # Final output also fires on some abnormal exits. Wait for the
            # authoritative run outcome before claiming a successful Stop.
            _remember(_TURNS, sid, {"response": _text(kwargs.get("assistant_response"))})
        elif event == "on_session_end":
            # RUN scoped, never session teardown. Exactly one Stop with the
            # actual final response AND authoritative interrupted/failed flag.
            turn = _TURNS.pop(sid, None)
            if turn is not None:
                payload["last_assistant_message"] = turn["response"]
                payload["interrupted"] = bool(kwargs.get("interrupted"))
                payload["aborted"] = bool(kwargs.get("failed")) or (not kwargs.get("completed", False) and not payload["interrupted"])
                _post("hermes_stop", payload)
        elif event == "on_session_finalize":
            _TURNS.pop(sid, None)
            _post("hermes_session_end", payload)


def register(ctx):
    for event in (
        "on_session_start", "pre_llm_call", "post_llm_call", "on_session_end",
        "on_session_finalize", "on_session_reset", "pre_tool_call", "post_tool_call",
        "subagent_start",
    ):
        def callback(_event=event, **kwargs):
            try:
                _handle(_event, **kwargs)
            except Exception:
                pass
            return None
        ctx.register_hook(event, callback)
