"""Identify prose-only changes in the actual PR merge tree. Unknown means scan."""
import re
import subprocess
import sys


def docs_only(base, merge):
    diff = subprocess.run(
        ["git", "diff", "--raw", "-z", "--no-renames", base, merge, "--"],
        stdout=subprocess.PIPE, check=False,
    )
    if diff.returncode or not diff.stdout.endswith(b"\0"):
        return False
    fields = diff.stdout[:-1].split(b"\0")
    if len(fields) % 2:
        return False
    for metadata, path in zip(fields[::2], fields[1::2]):
        if not re.fullmatch(rb":(?:100644|000000) (?:100644|000000) [0-9a-f]+ [0-9a-f]+ [AMD]", metadata):
            return False
        if not re.fullmatch(rb"(README|SECURITY|CONTRIBUTING|CODE_OF_CONDUCT)\.md|docs/(?:security-scanning|security-response\.ko|devlog/entries/[\w.-]+)\.md", path):
            return False
    return True


if __name__ == "__main__":
    print("docs_only=" + str(docs_only(*sys.argv[1:])).lower())
