"""Expose received close payloads to the existing virtual messageReceived seam.

arduinoWebSockets 2.7.3 otherwise discards the close code. Compile a build-local
copy, leaving downloaded dependencies intact. Refuse an unrecognized upstream
shape instead of silently shipping auth recovery without close observations.
"""
from pathlib import Path


def with_close_event(source):
    start = source.index("case WSop_close: {")
    end = source.index("} break;", start)
    block = source[start:end]
    anchor = "clientDisconnect(client, 1000);"
    if block.count(anchor) != 1:
        raise ValueError("Unsupported arduinoWebSockets close handler")
    block = block.replace(anchor, "messageReceived(client, WSop_close, payload, header->payloadLen, header->fin);\n                " + anchor)
    return source[:start] + block + source[end:]


def install(env):
    def middleware(build_env, node):
        original = Path(node.srcnode().get_abspath())
        if original.parent.parent.name != "WebSockets":
            return node
        print("[ws-auth] observing received close frames in", original.name)
        patched = Path(build_env.subst("$BUILD_DIR")) / "agentdeck-websockets" / "WebSockets.cpp"
        patched.parent.mkdir(parents=True, exist_ok=True)
        source = with_close_event(original.read_text())
        if not patched.exists() or patched.read_text() != source:
            patched.write_text(source)
        return build_env.Object(
            target=str(patched) + ".o", source=str(patched),
            CPPPATH=build_env["CPPPATH"] + [str(original.parent)],
        )
    env.AddBuildMiddleware(middleware, "*WebSockets.cpp")


try:
    Import("env")
except NameError:  # Plain host imports exercise the transformation without PIO.
    pass
else:
    install(env)
