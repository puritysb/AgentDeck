"""AgentDeck Hermes observer v1. No hook changes Hermes execution.

Contract: NousResearch/hermes-agent@0a374d167, hermes.observer.v1.
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
import re
import shlex
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
_CONTEXT = OrderedDict()
_MAX_TRACKED = 512
_CI_RULES = json.loads((Path(__file__).parent / "ci-wait-rules.json").read_text())
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
    # Real Gateway tool callbacks omit platform. Missing context must not
    # relabel a Gateway conversation as CLI or leak its host's working directory.
    platform = _text(kwargs.get("platform"), 40)
    if platform:
        _remember(_CONTEXT, identity, {
            "cwd": os.getcwd() if platform.lower() == "cli" else "",
            # ASCII only: small board fonts lack U+00B7.
            "project_name": "Hermes (" + platform + ")",
            "platform": platform.lower(),
        })
    return {
        "session_id": identity,
        **_CONTEXT.get(identity, {}),
        "model": _text(kwargs.get("model"), 200),
        # Lets the daemon close the row when this process is gone. One-shot
        # mode (`hermes -z`) hard-exits through os._exit without firing
        # on_session_finalize or atexit, so no event can carry that end.
        "pid": os.getpid(),
    }


def _tool_id(sid, value):
    # Upstream ids can be model-controlled. Never export the original string.
    if not isinstance(value, str) or not value or len(value) > _CI_RULES["maxCommandChars"]:
        return None
    return "hermes-tool-" + hashlib.sha256((sid + "\0" + value).encode()).hexdigest()[:32]


def _ci_intent(tool, args):
    # Deliberately narrower than the daemon shell grammar: one explicit gh
    # watch only. Shell chains, substitutions, env wrappers and polling loops
    # are not forwarded. Everything is classified locally and then discarded.
    if tool != "terminal" or not isinstance(args, dict):
        return None
    command = args.get("command")
    if not isinstance(command, str) or len(command) > _CI_RULES["maxCommandChars"]:
        return None
    if any(c in command for c in _CI_RULES["forbidden"] + ";|&<>\n\r"):
        return None
    try:
        argv = shlex.split(command, comments=True)
    except ValueError:
        return None
    if not argv or argv.pop(0).split("/")[-1] != "gh":
        return None
    intent = {"kind": "ci", "provider": "github-actions", "mode": "watch"}
    def repository(value):
        return isinstance(value, str) and len(value) <= _CI_RULES["maxIdentityChars"] and re.fullmatch(_CI_RULES["repoPattern"], value)
    def number(value):
        return isinstance(value, str) and re.fullmatch(_CI_RULES["numberPattern"], value) and len(value) <= 16 and int(value) <= _CI_RULES["maxId"]
    def take_repo():
        if argv and argv[0] in ("-R", "--repo"):
            argv.pop(0)
            value = argv.pop(0) if argv else None
        elif argv and argv[0].startswith("--repo="):
            value = argv.pop(0)[7:]
        else:
            return False
        if not repository(value):
            raise ValueError("invalid repository")
        intent["repo"] = value
        return True
    try:
        while take_repo():
            pass
        if len(argv) < 2:
            return None
        group, action = argv.pop(0), argv.pop(0)
        if (group, action) not in (("run", "watch"), ("pr", "checks")):
            return None
        grammar = _CI_RULES["runWatch" if group == "run" else "prChecks"]
        watch = group == "run"
        identity = None
        while argv:
            if take_repo():
                continue
            arg = argv.pop(0)
            if arg == "--watch" and group == "pr":
                watch = True
                continue
            option, equal, value = arg.partition("=")
            if option in grammar["values"]:
                value = value if equal else (argv.pop(0) if argv else None)
                if not value:
                    return None
            elif arg in grammar["switches"]:
                continue
            elif arg.startswith("-") or identity is not None:
                return None
            else:
                identity = arg
        if not watch:
            return None
        if group == "run":
            if not number(identity):
                return None
            intent["runId"] = int(identity)
        elif identity is not None:
            url = re.fullmatch(_CI_RULES["urlPattern"], identity)
            if url:
                if not repository(url[1]) or not number(url[2]) or intent.get("repo", url[1]) != url[1]:
                    return None
                intent.update(repo=url[1], pr=int(url[2]))
            elif number(identity):
                intent["pr"] = int(identity)
            elif (re.fullmatch(_CI_RULES["digitsPattern"], identity) or len(identity) > _CI_RULES["maxIdentityChars"] or
                  not re.fullmatch(_CI_RULES["branchPattern"], identity)):
                return None
            else:
                intent["ref"] = identity
        return intent
    except ValueError:
        return None


def _deliver(event, payload):
    # Resolve every delivery: a daemon restart can move the port.
    data_dir = os.environ.get("AGENTDECK_DATA_DIR")
    registry = (Path(data_dir).expanduser() if data_dir else Path.home() / ".agentdeck") / "daemon.json"
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
                _CONTEXT.pop(_identity(old), None)
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
            call_id = _tool_id(sid, kwargs.get("tool_call_id"))
            if call_id:
                payload["tool_call_id"] = call_id
                if event == "pre_tool_call":
                    intent = _ci_intent(kwargs.get("tool_name"), kwargs.get("args"))
                    if intent:
                        payload["ci_wait_intent"] = intent
                        payload["ci_wait_background"] = kwargs["args"].get("background") is True
                else:
                    # Pinned upstream emits an authoritative terminal status.
                    # A tool error clears the wait, never invents a CI failure.
                    payload["is_error"] = kwargs.get("status") in ("error", "blocked", "cancelled", "timeout")
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
            _CONTEXT.pop(sid, None)


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
