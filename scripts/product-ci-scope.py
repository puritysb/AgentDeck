"""Select native product tests. An unreadable base runs both suites."""
import os
import subprocess
import sys

diff = subprocess.run(["git", "diff", "--no-renames", "--name-only", "-z",
                       f"{sys.argv[1]}...{sys.argv[2]}"], stdout=subprocess.PIPE)
paths = [os.fsdecode(p) for p in diff.stdout.split(b"\0") if p]
common = {".github/workflows/ci.yml", "scripts/product-ci-scope.py"}
apple = common | {".github/workflows/apple-test.yml", ".github/workflows/apple-release.yml", "docs/appstore-metadata-draft.md",
                  "bridge/src/glance-frame.ts", "scripts/generate-glance-policy.mjs"}
android = common | {".github/workflows/android-test.yml"}
for name, files, dirs in [
    ("apple", apple, ("apple/", "shared/", "bridge/assets/fonts/", "generated/protocol/")),
    ("android", android, ("android/",)),
]:
    selected = diff.returncode != 0 or any(path in files or path.startswith(dirs) for path in paths)
    print(f"{name}={str(selected).lower()}")
