"""Check profile-managed Release capabilities before Xcode starts archiving."""
import plistlib
import sys
from pathlib import Path


def verify(profile, requested):
    release_values = {"$(AGENTDECK_ICLOUD_ENVIRONMENT)": "Production",
                      "$(AGENTDECK_APNS_ENVIRONMENT)": "production"}
    for key, raw in requested.items():
        if key != "aps-environment" and not key.startswith("com.apple.developer."):
            continue
        allowed = profile.get(key, [])
        allowed = allowed if isinstance(allowed, list) else [allowed]
        for item in raw if isinstance(raw, list) else [raw]:
            value = release_values.get(item, item)
            if value in allowed:
                continue
            if isinstance(value, str) and any(isinstance(v, str) and v.endswith("*")
                                             and value.startswith(v[:-1]) for v in allowed):
                continue
            raise ValueError(f"profile does not authorize {key} = {value}")


if __name__ == "__main__":
    profile, requested = map(Path, sys.argv[1:])
    try:
        verify(plistlib.loads(profile.read_bytes())["Entitlements"], plistlib.loads(requested.read_bytes()))
    except ValueError as error:
        sys.exit(f"{requested.name}: {error}")
