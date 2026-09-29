"""Keep IPS10 Arduino headers paired with hybrid-rebuilt IDF libraries.

pioarduino 55.03.311 copies custom SDK archives/sdkconfig back into its package,
but leaves the packaged managed-component headers untouched. Dependency
resolution can advance esp_wifi_remote: its wifi_init_config_t then has a new
field before magic, while Arduino WiFi still compiles the old struct. The peer
rejects the shifted magic with ESP_ERR_INVALID_ARG. Prefer headers from the
same managed_components source that the hybrid phase compiled, in SDK order.
Do not mutate the shared PlatformIO package (other boards use it).
"""
from pathlib import Path
import shlex

Import("env")  # noqa: F821

if env["PIOENV"] == "ips10":
    board = env.BoardConfig()
    variant = board.get("build.chip_variant", board.get("build.mcu"))
    package = env.PioPlatform().get_package_dir("framework-arduinoespressif32-libs")
    includes = Path(package) / variant / "flags" / "includes"
    managed = Path(env.subst("$PROJECT_DIR")) / "managed_components"
    if includes.is_file() and managed.is_dir():
        words = shlex.split(includes.read_text())
        paths = []
        for i, word in enumerate(words[:-1]):
            if word != "-iwithprefixbefore":
                continue
            path = managed / words[i + 1]
            if path.is_dir():
                paths.append(str(path))
        # Put these before the SDK's response-file include flags for the core,
        # Arduino libraries and application alike, including cloned envs.
        env.Prepend(CCFLAGS=["-I" + p for p in paths])
        print("[ips10-sdk] Using %d matching managed-component header paths" % len(paths))
