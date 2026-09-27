#!/usr/bin/env python3
"""AgentDeck — Design tokens sync verifier.

design/tokens.css is the single source of truth. Every other token file
is a language-specific mirror:

    design/tokens.js                                           (browser, window.DT.*)
    shared/src/design-tokens.ts                                (TS)
    apple/AgentDeck/UI/Common/DesignTokens.swift               (SwiftUI)
    android/app/src/main/kotlin/dev/agentdeck/ui/theme/DesignTokens.kt  (Compose)

This verifier parses tokens.css into (group, key, value, kind) tuples,
maps each CSS token name to the expected mirror key, and asserts that
each mirror contains the matching `key … value` line. It also runs in
reverse — every hex literal that appears in a mirror must trace back
to tokens.css — so a mirror cannot smuggle in a stray color.

Exit code:  0 if all mirrors are in sync, 1 if drift is detected,
2 if an input file is missing.

Usage:  python3 design/verify-tokens-sync.py
"""

from __future__ import annotations

import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CSS = ROOT / "design" / "tokens.css"

# Each mirror declares (a) which token kinds it is required to mirror and
# (b) any specific CSS tokens within those kinds that it intentionally omits,
# with a rationale. Anything in `kinds` that is not in `omit` MUST appear in
# the mirror or the verifier reports drift — the omit list makes intentional
# gaps auditable instead of silent.
#
# tokens.js exists only to serve the browser mockups (data.js consumes
# colour values via window.DT) — px/ms tokens have no consumer there, so
# it scopes itself to colours only.
ALL_KINDS = frozenset({"color", "px", "ms", "em", "fontstack", "string"})

# Two mirror styles:
#   "binding": language-native const/enum/object whose keys/values translate
#              the canonical CSS to TS/Swift/Kotlin/JS form. Verified by the
#              find_*_binding family scoped to each group block.
#   "css-root": HTML or CSS file with a `:root { --name: value; … }` block
#              that re-declares a SUBSET of the canonical tokens verbatim
#              (apme-dashboard, plugin PI). Verified by parsing the :root,
#              comparing each `--name → value` to the canonical, and
#              flagging stray declarations with no canonical counterpart.
#              Required because lint.sh treats these files as token sources
#              (TOKEN_FILES allowlist) — without a verifier mirror, hex
#              drift inside the :root would pass silently.
MIRRORS = {
    "js": {
        "type": "binding",
        "path": ROOT / "design" / "tokens.js",
        "kinds": frozenset({"color"}),
        "omit": {},
    },
    "ts": {
        "type": "binding",
        "path": ROOT / "shared" / "src" / "design-tokens.ts",
        "kinds": ALL_KINDS,
        "omit": {},
    },
    "swift": {
        "type": "binding",
        "path": ROOT / "apple" / "AgentDeck" / "UI" / "Common" / "DesignTokens.swift",
        "kinds": ALL_KINDS,
        "omit": {
            "--t-hero":      "clamp() fluid type doesn't translate to UIKit/SwiftUI; native Dynamic Type used instead",
            "--t-editorial": "clamp() fluid type doesn't translate to UIKit/SwiftUI; native Dynamic Type used instead",
            "--t-page-title": "clamp() fluid type doesn't translate to UIKit/SwiftUI; native Dynamic Type used instead",
            "--sh-card":     "shadows applied via SwiftUI .shadow modifiers, not pre-rendered",
            "--sh-card-h":   "shadows applied via SwiftUI .shadow modifiers, not pre-rendered",
            "--sh-frame":    "shadows applied via SwiftUI .shadow modifiers, not pre-rendered",
            "--sh-canvas":   "shadows applied via SwiftUI .shadow modifiers, not pre-rendered",
            "--ease-snap":   "easing modeled with Animation.timingCurve in call sites, not stored as constant",
        },
    },
    "kotlin": {
        "type": "binding",
        "path": ROOT / "android" / "app" / "src" / "main" / "kotlin"
        / "dev" / "agentdeck" / "ui" / "theme" / "DesignTokens.kt",
        "kinds": ALL_KINDS,
        "omit": {
            "--t-hero":      "clamp() fluid type doesn't translate to Compose; sp values via FontSize used instead",
            "--t-editorial": "clamp() fluid type doesn't translate to Compose; sp values via FontSize used instead",
            "--t-page-title": "clamp() fluid type doesn't translate to Compose; sp values via FontSize used instead",
            "--sh-card":     "shadows applied via Modifier.shadow, not pre-rendered",
            "--sh-card-h":   "shadows applied via Modifier.shadow, not pre-rendered",
            "--sh-frame":    "shadows applied via Modifier.shadow, not pre-rendered",
            "--sh-canvas":   "shadows applied via Modifier.shadow, not pre-rendered",
            "--ease-snap":   "easing modeled with CubicBezierEasing at call sites",
        },
    },
    "apme-dashboard": {
        "type": "css-root",
        "path": ROOT / "apple" / "AgentDeck" / "Resources" / "apme-dashboard.html",
    },
    "sd-pi": {
        "type": "css-root",
        "path": ROOT / "plugin" / "bound.serendipity.agentdeck.sdPlugin"
                     / "ui" / "design-tokens.css",
    },
    # Build Health generator: its CSS lives inside a Python f-string, so braces
    # are doubled ({{ }}); unescape before the :root parse. Aliases like --bg
    # resolve via var(--canonical) and are validated transitively.
    "build-health": {
        "type": "css-root",
        "path": ROOT / "scripts" / "generate-html-report.py",
        "unescape_braces": True,
        # :root declarations only. The generator's BODY also carries chart /
        # badge hex (sparklines, category colors) that predate the token
        # system; sweeping them is a separate normalization, tracked in the
        # design-lint baseline, not a sync gate.
        "body_sweep": False,
    },
}

# ─── CSS parsing ──────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Token:
    css_name: str          # "--ui-popup-bg-dark"
    group: str             # "UI"
    key: str               # "popupBgDark"
    value: str             # "#0a1a2a" — the *resolved* value (hex/numeric/string)
    kind: str              # "color" | "px" | "ms" | "em" | "fontstack" | "string"
    ref: str | None = None # canonical referent for var()-derivatives, e.g. "--ink-300"


# CSS group head → mirror group name.  Some heads (font/t/tr/s/r/sh/d/ease)
# don't fold by simple capitalisation, so they're listed explicitly.
GROUP_MAP = {
    "tide": "Tide",
    "ink": "Ink",
    "kelp": "Kelp",
    "coral": "Coral",
    "amber": "Amber",
    "brand": "Brand",
    "status": "Status",
    "ui": "UI",
    "session": "Session",
    "font": "Font",
    "t": "Type",
    "tr": "Tracking",
    "s": "Spacing",
    "container": "Layout",
    "section": "Layout",
    "r": "Radius",
    "sh": "Shadow",
    "d": "Motion",
    "ease": "Motion",
}

# Per-token name overrides where mechanical conversion would be wrong.
# Maps css_name → key.
KEY_OVERRIDES = {
    "--r-2xl": "xxl",
    "--r-3xl": "xxxl",
    "--r-4xl": "xxxxl",
    "--sh-card-h": "cardHover",
    "--container-max": "containerMax",
    "--container-pad": "containerPad",
    "--section-y": "sectionY",
    "--ease-snap": "easeSnap",
}

# Per-language overrides for mirror group container names. Default = same as
# canonical group. Catches the cases where Swift/Kotlin diverge (Type group
# is named FontSize at the call site, Font group is FontFamilyName in Compose).
MIRROR_GROUP_NAMES: dict[str, dict[str, str]] = {
    "swift":  {"Type": "FontSize"},
    "kotlin": {"Type": "FontSize", "Font": "FontFamilyName"},
}


def mirror_group_name(group: str, lang: str) -> str:
    return MIRROR_GROUP_NAMES.get(lang, {}).get(group, group)


def _block_for(text: str, group: str, lang: str) -> str | None:
    """Return the body of the named container (`enum`, `object`, `const`)
    that holds this group's bindings, or None if the group is absent.

    Token bindings outside their group's body — `Ink.s50 = "#f5f3ec"`
    (Tide value misplaced inside Ink) — are silent drift today; once every
    binding check is scoped to its own block, the misplacement reads as a
    *missing* binding for the right group AND a *stray* binding inside the
    wrong one (the latter caught by the reverse-direction sweeps).
    """
    name = mirror_group_name(group, lang)
    if lang in ("js", "ts"):
        head = re.compile(rf"(?:export\s+)?const\s+{re.escape(name)}\s*=\s*\{{")
    elif lang == "swift":
        head = re.compile(rf"\benum\s+{re.escape(name)}\s*\{{")
    elif lang == "kotlin":
        head = re.compile(rf"\bobject\s+{re.escape(name)}\s*\{{")
    else:
        return None

    m = head.search(text)
    if not m:
        return None
    depth = 1
    i = m.end()
    while i < len(text):
        c = text[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return text[m.end():i]
        i += 1
    return None


def kebab_to_camel(parts: list[str]) -> str:
    if not parts:
        return ""
    head = parts[0]
    tail = "".join(p.capitalize() for p in parts[1:])
    return head + tail


def derive_key(css_name: str) -> str:
    """Map a CSS variable name to its mirror key."""
    if css_name in KEY_OVERRIDES:
        return KEY_OVERRIDES[css_name]

    parts = css_name.lstrip("-").split("-")
    if len(parts) == 1:
        return parts[0]

    head, *rest = parts

    # Numeric scale tokens: --tide-50 → s50, --s-4 → s4
    if len(rest) == 1 and rest[0].isdigit():
        return f"s{rest[0]}"

    return kebab_to_camel(rest)


_HEX_RE = re.compile(r"#[0-9a-fA-F]{3,8}\b")
_PX_RE = re.compile(r"^(-?[0-9]+(?:\.[0-9]+)?)px$")
_MS_RE = re.compile(r"^(-?[0-9]+(?:\.[0-9]+)?)ms$")
_EM_RE = re.compile(r"^(-?[0-9]+(?:\.[0-9]+)?)em$")
_FONT_FAMILY_RE = re.compile(r'"([^"]+)"|\'([^\']+)\'')
_VAR_RE = re.compile(r"^var\(\s*(--[a-z0-9-]+)\s*\)$")
_DECL_RE = re.compile(
    r"^\s*(--[a-z0-9-]+)\s*:\s*(.+?)\s*;?\s*$"
)


_BLOCK_COMMENT_RE = re.compile(r"/\*.*?\*/", re.DOTALL)


def _classify_value(raw_value: str, group: str) -> tuple[str, str] | None:
    """Pure classifier — returns (kind, value) for direct (non-var) values, or
    None if the value isn't recognized."""
    if _HEX_RE.fullmatch(raw_value):
        return "color", raw_value.lower()
    if m := _PX_RE.match(raw_value):
        return "px", m.group(1)
    if m := _MS_RE.match(raw_value):
        return "ms", m.group(1)
    if m := _EM_RE.match(raw_value):
        return "em", m.group(1)
    if group == "Font":
        families = [m.group(1) or m.group(2) for m in _FONT_FAMILY_RE.finditer(raw_value)]
        return "fontstack", "|".join(families)
    return "string", re.sub(r"\s+", " ", raw_value)


def parse_css(text: str) -> list[Token]:
    """Extract --name: value declarations from tokens.css.

    Two-pass parse:
      1. First pass collects every declaration as (name, raw_value) and a
         direct-value map for non-var tokens.
      2. Second pass walks each declaration. Direct values become a regular
         Token; `var(--target)` values resolve recursively against the direct
         map and become a Token whose `value/kind` come from the resolved
         target and whose `ref` records the canonical CSS name pointed at.
         The mirror check then verifies the derivative binding *references*
         the right target (e.g. `Status.idle = Ink.s300`), catching swaps
         that the prior verifier silently skipped.

    Block comments are stripped first so commented-out declarations cannot
    inject phantom values into the parser.
    """
    text = _BLOCK_COMMENT_RE.sub("", text)

    # Collapse multi-line declarations: any line that doesn't end with `;`
    # belongs to the previous declaration.
    flat: list[str] = []
    buf = ""
    for raw in text.splitlines():
        stripped = raw.strip()
        if not stripped:
            if buf:
                flat.append(buf)
                buf = ""
            continue
        if buf:
            buf += " " + stripped
        else:
            buf = stripped
        if buf.endswith(";"):
            flat.append(buf.rstrip(";"))
            buf = ""
    if buf:
        flat.append(buf)

    # First pass: gather (name, raw_value) tuples and a direct-value map.
    decls: list[tuple[str, str]] = []
    direct: dict[str, tuple[str, str]] = {}
    for line in flat:
        m = _DECL_RE.match(line)
        if not m:
            continue
        name, raw_value = m.group(1), m.group(2).strip()
        decls.append((name, raw_value))
        if _VAR_RE.match(raw_value):
            continue
        head = name.lstrip("-").split("-", 1)[0]
        group = GROUP_MAP.get(head, "")
        classified = _classify_value(raw_value, group)
        if classified is not None:
            direct[name] = classified

    def resolve(name: str, depth: int = 0) -> tuple[str, str, str] | None:
        """Resolve a name to (kind, value, root_target) following var chains.
        Returns None on cycle or unresolvable reference."""
        if depth > 8:
            return None
        if name in direct:
            kind, value = direct[name]
            return kind, value, name
        # Look up the var target for `name` in decls
        for n, rv in decls:
            if n != name:
                continue
            if m := _VAR_RE.match(rv):
                return resolve(m.group(1), depth + 1)
            return None
        return None

    # Second pass: build tokens. Vars get ref=target_name + resolved value.
    tokens: list[Token] = []
    for name, raw_value in decls:
        head = name.lstrip("-").split("-", 1)[0]
        group = GROUP_MAP.get(head)
        if not group:
            continue
        key = derive_key(name)

        if vm := _VAR_RE.match(raw_value):
            target_name = vm.group(1)
            resolved = resolve(target_name)
            if not resolved:
                continue  # broken var ref — nothing to verify
            kind, value, _root = resolved
            tokens.append(Token(name, group, key, value, kind, ref=target_name))
            continue

        classified = _classify_value(raw_value, group)
        if classified is None:
            continue
        kind, value = classified
        tokens.append(Token(name, group, key, value, kind))

    return tokens


# ─── Mirror checks ────────────────────────────────────────────────────────────


def find_color_binding(text: str, key: str, hex_value: str, lang: str) -> bool:
    """Return True if a line in `text` binds `key` to `hex_value`."""
    bare = hex_value.lstrip("#")
    if lang == "kotlin":
        # `val key = Color(0xFFRRGGBB)` — case-insensitive on hex
        pat = re.compile(
            rf"\b{re.escape(key)}\s*=\s*Color\(\s*0x[fF]{{2}}{bare}\b",
            re.IGNORECASE,
        )
    elif lang == "swift":
        pat = re.compile(
            rf"\b{re.escape(key)}\s*=\s*tokenColor\(\s*\"#{bare}\"",
            re.IGNORECASE,
        )
    elif lang in ("js", "ts"):
        # `key: '#rrggbb'` or `key: "#rrggbb"`
        pat = re.compile(
            rf"\b{re.escape(key)}\s*:\s*['\"]#{bare}\b",
            re.IGNORECASE,
        )
    else:
        return False
    return bool(pat.search(text))


_GENERIC_CSS_FAMILIES = {
    "sans-serif", "monospace", "system-ui",
    "-apple-system", "BlinkMacSystemFont", "ui-monospace",
}

_LINE_COMMENT_RE = re.compile(r"//[^\n]*")
_BLOCK_COMMENT_MIRROR_RE = re.compile(r"/\*.*?\*/", re.DOTALL)
_HTML_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)


def _strip_comments(text: str) -> str:
    """Drop comment forms whose CONTENT should be ignored entirely. HTML
    comments are deliberately NOT stripped here — they're masked only when
    scanning for real <style> regions (so a fake `<style>` inside `<!-- -->`
    can't pose as real CSS), but stay visible to the body-hex sweep so any
    raw hex they hide is still reported.

    Two forms removed:
      • `/* … */` block comments — strip before line accumulation.
      • `//` line comments       — mirror-only; safe because canonical
        token values never contain `//`.
    """
    text = _BLOCK_COMMENT_MIRROR_RE.sub("", text)
    text = _LINE_COMMENT_RE.sub("", text)
    return text


def _mask_html_comments(text: str) -> str:
    """Replace `<!-- … -->` regions with spaces (newlines preserved).
    Used by real-CSS detection so an HTML comment can't make a fake
    `<style>` substring inside it pass as real CSS. The body-hex sweep
    intentionally does NOT call this — hex hidden inside HTML comments
    must remain visible to that sweep, since `<!-- … #deadbe … -->` is
    just as much a foothold for silent drift as bare-body hex.
    """
    out = list(text)
    for m in _HTML_COMMENT_RE.finditer(text):
        for i in range(m.start(), m.end()):
            if out[i] != "\n":
                out[i] = " "
    return "".join(out)


def _string_captures(text: str, key: str, lang: str) -> list[str]:
    """Return the values that `text` binds to `key` for the given language."""
    if lang in ("js", "ts"):
        # `key: 'literal'` / `key: "literal"`
        pat = re.compile(rf"\b{re.escape(key)}\s*:\s*(['\"])(.*?)\1", re.DOTALL)
        return [m.group(2) for m in pat.finditer(text)]
    if lang in ("swift", "kotlin"):
        # Swift: `static let key = "v"` / `static let key: T = "v"`
        # Kotlin: `val key = "v"` / `const val key = "v"` / `val key: T = "v"`
        pat = re.compile(
            rf"\b{re.escape(key)}\s*(?::\s*\S+\s*)?=\s*\"([^\"]*)\"",
            re.DOTALL,
        )
        return [m.group(1) for m in pat.finditer(text)]
    return []


def find_string_binding(text: str, key: str, value: str, lang: str) -> bool:
    """Anchored check: the canonical CSS value must be the value actually
    bound to `key` (case-insensitive whitespace match), not merely present
    somewhere else in the file. Catches swapped bindings, e.g. `Shadow.card`
    holding the `--sh-card-h` literal while `Shadow.cardHover` holds
    `--sh-card`'s — a swap the previous substring check passed silently.
    """
    norm_value = re.sub(r"\s+", " ", value).strip()
    for cap in _string_captures(text, key, lang):
        norm_cap = re.sub(r"\s+", " ", cap).strip()
        if norm_cap == norm_value:
            return True
    return False


def find_fontstack_binding(
    text: str, key: str, families: list[str], lang: str
) -> list[str]:
    """Anchored check for font stacks. Returns the families NOT present in
    the value(s) bound to `key`.

    Languages differ in convention:
      - TS/JS: `--font-sans` maps to one string literal with the full stack;
        the mirror's bound value must contain every CSS family.
      - Swift/Kotlin: the CSS stack is split across multiple keys whose names
        share a prefix (e.g. `sans`, `sansKR`, `sansJP` for `--font-sans`).
        Each CSS family must appear quoted in *some* binding whose key starts
        with the canonical key — `mono` families inside `sans*` keys are a
        swap and reported as missing for the sans stack.
    """
    families = [f for f in families if f not in _GENERIC_CSS_FAMILIES]

    if lang in ("js", "ts"):
        captures = _string_captures(text, key, lang)
        if not captures:
            return families[:]
        # Use longest capture (avoids picking up sub-key collisions).
        bound = max(captures, key=len)
        return [f for f in families if f not in bound]

    if lang in ("swift", "kotlin"):
        # Find every `<key-prefix><suffix> = "value"` binding.
        # Restrict to keys that start with the canonical key (case-insensitive),
        # matching the project convention `sans`, `sansKR`, `sansJP`, `sansFallback`.
        prefix_pat = re.compile(
            rf"\b({re.escape(key)}[A-Za-z0-9]*)\s*(?::\s*\S+\s*)?=\s*\"([^\"]*)\"",
            re.DOTALL | re.IGNORECASE,
        )
        bound_strings: list[str] = [m.group(2) for m in prefix_pat.finditer(text)]
        if not bound_strings:
            return families[:]
        joined = " | ".join(bound_strings)
        return [f for f in families if f not in joined]

    return families[:]


def find_reference_binding(
    text: str, key: str, target_group: str, target_key: str, lang: str
) -> bool:
    """Anchored check for derivative tokens. The mirror must bind `key` to
    the literal identifier `target_group.target_key` (e.g. `Status.idle =
    Ink.s300`). Catches the var() swap silent drift where Status.idle could
    point to Tide.s50 (right hex by coincidence, wrong semantic).
    """
    expected = rf"\b{re.escape(target_group)}\.{re.escape(target_key)}\b"
    if lang in ("js", "ts"):
        pat = re.compile(rf"\b{re.escape(key)}\s*:\s*{expected}")
    elif lang in ("swift", "kotlin"):
        pat = re.compile(
            rf"\b{re.escape(key)}\s*(?::\s*\S+\s*)?=\s*{expected}"
        )
    else:
        return False
    return bool(pat.search(text))


def find_numeric_binding(text: str, key: str, value: str, kind: str, lang: str) -> bool:
    """Return True if a line binds `key` to numeric `value` (px or ms).

    Each language uses a different unit convention:
      CSS    `16px`   `120ms`
      JS/TS  `16`     `120`        (numeric, or `"16px"` string for Type tokens)
      Swift  `16`     `120`        (CGFloat / Int)
      Kotlin `16.dp`  `120`        (Dp / Int)
    We accept any form that matches the magnitude.
    """
    val_pat = rf"{re.escape(value)}(?:\.0+)?"
    if lang == "kotlin":
        pats = [
            rf"\b{re.escape(key)}\s*:\s*Dp\s*=\s*{val_pat}\.dp\b",
            rf"\b{re.escape(key)}\s*=\s*{val_pat}f?\b",
        ]
    elif lang == "swift":
        pats = [
            rf"\b{re.escape(key)}\s*:\s*(?:CGFloat|Double|Int)\s*=\s*{val_pat}\b",
            rf"\b{re.escape(key)}\s*=\s*{val_pat}\b",
        ]
    elif lang in ("js", "ts"):
        # `s4: 4,` (number) or `h2: "44px",` (CSS string for Type tokens)
        pats = [
            rf"\b{re.escape(key)}\s*:\s*{val_pat}[,\s}}]",
            rf"\b{re.escape(key)}\s*:\s*['\"]{val_pat}{kind}['\"]",
        ]
    else:
        return False

    for p in pats:
        if re.search(p, text):
            return True
    return False


# ─── Reverse direction ────────────────────────────────────────────────────────


def extract_bound_keys(block: str, lang: str) -> set[str]:
    """All bound keys defined inside a group block, language-aware. Used by
    the per-block reverse stray check: any key here that has no CSS
    counterpart in the group is a stray binding (catches Spacing.s7, a
    Tide value duplicated into Ink, etc.)."""
    if lang in ("js", "ts"):
        # `key: value` at top of an object literal (flat — no nesting in our
        # design tokens). Skip the trailing `}` etc. by anchoring to start of line.
        pat = re.compile(r"^\s*([A-Za-z_]\w*)\s*:", re.MULTILINE)
    elif lang == "swift":
        pat = re.compile(r"^\s*static\s+let\s+([A-Za-z_]\w*)\s*[:=]", re.MULTILINE)
    elif lang == "kotlin":
        pat = re.compile(
            r"^\s*(?:const\s+val|val)\s+([A-Za-z_]\w*)\s*[:=]", re.MULTILINE
        )
    else:
        return set()
    return {m.group(1) for m in pat.finditer(block)}


_STYLE_TAG_RE = re.compile(r"<style[^>]*>(.*?)</style>", re.DOTALL | re.IGNORECASE)
_SCRIPT_TAG_RE = re.compile(r"<script\b[^>]*>(.*?)</script\s*>", re.DOTALL | re.IGNORECASE)
_ROOT_BLOCK_RE = re.compile(r":root\s*\{")


def _mask_script_bodies(text: str) -> str:
    """Replace `<script>…</script>` bodies with spaces (newlines preserved).

    Run before scanning for `<style>` tags so a fake `<style>…</style>`
    embedded in a JS template string can't masquerade as a real CSS
    region. Without this step an attacker (or a careless paste) hides
    raw hex inside `<script>const x = '<style>:root{ #deadbe }</style>';</script>`
    — the body-sweep mask covered that fake :root and the validator
    skipped the non-`--name:` content.
    """
    out = list(text)
    for m in _SCRIPT_TAG_RE.finditer(text):
        for i in range(m.start(1), m.end(1)):
            if out[i] != "\n":
                out[i] = " "
    return "".join(out)


def _extract_css_from_html(text: str) -> str:
    """Concatenate every real <style>…</style> block. Both script bodies
    AND HTML comments are masked first so a `<style>` substring tucked
    inside either can't sneak in as real CSS."""
    masked = _mask_script_bodies(text)
    masked = _mask_html_comments(masked)
    blocks = [m.group(1) for m in _STYLE_TAG_RE.finditer(masked)]
    return "\n".join(blocks) if blocks else ""


def _root_block_ranges(css_text: str) -> list[tuple[int, int]]:
    """Return (start, end) char positions for every `:root { … }` region in
    `css_text`, brace-balanced. Used both to extract the bodies for declaration
    checks and to mask those regions when scanning for body-side hex drift.
    """
    ranges: list[tuple[int, int]] = []
    for m in _ROOT_BLOCK_RE.finditer(css_text):
        depth = 1
        i = m.end()
        while i < len(css_text):
            c = css_text[i]
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    ranges.append((m.start(), i + 1))
                    break
            i += 1
    return ranges


def _extract_root_blocks(css_text: str) -> list[str]:
    """Bodies of every `:root { … }` block (brace-balanced)."""
    out: list[str] = []
    for start, end in _root_block_ranges(css_text):
        # Skip the `:root {` header up to the first `{` for the body slice.
        head_len = css_text[start:end].index("{") + 1
        out.append(css_text[start + head_len : end - 1])
    return out


def _real_css_regions(text: str, suffix: str) -> list[tuple[int, int]]:
    """Return (start, end) ranges where `text` is real CSS.
      .html → each <style>…</style> body, with script bodies AND
              `<!-- … -->` comments masked first so `<style>` substrings
              tucked inside either don't qualify as real CSS
      .css  → the whole file
    """
    if suffix.lower() in (".html", ".htm"):
        masked = _mask_script_bodies(text)
        masked = _mask_html_comments(masked)
        return [(m.start(1), m.end(1)) for m in _STYLE_TAG_RE.finditer(masked)]
    return [(0, len(text))]


def _mask_root_regions(text: str, suffix: str) -> str:
    """Return `text` with every REAL-CSS `:root { … }` region replaced by
    space (newlines preserved). The body-hex sweep then runs against the
    rest of the file.

    Only real CSS regions are eligible for masking — a fake `:root { … }`
    embedded in a JS template string or HTML attribute is *not* masked,
    so any raw hex inside that fake block stays exposed. Without this
    scoping, an attacker (or a tired engineer pasting `'<style>:root{…}</style>'`
    into JS) could hide a stray colour from the lint allowlist + verifier
    pair entirely.
    """
    out = list(text)
    for css_start, css_end in _real_css_regions(text, suffix):
        css_substr = text[css_start:css_end]
        for r_start, r_end in _root_block_ranges(css_substr):
            for i in range(css_start + r_start, css_start + r_end):
                if out[i] != "\n":
                    out[i] = " "
    return "".join(out)


def verify_css_root_mirror(
    path: Path, canonical_by_name: dict[str, "Token"],
    unescape_braces: bool = False, body_sweep: bool = True
) -> tuple[list[str], list[str]]:
    """Validate an HTML / CSS file whose `:root` block declares a subset of
    the canonical design tokens. Returns (drift_messages, stray_messages).

    Rules:
      • Every `--name: hex` in :root must match the canonical hex of the same name.
      • Every `--name: var(--target)` is allowed if `--target` is a canonical token.
      • Every `--name` not in canonical is reported as stray (the alias `--bg`
        is excluded — those are local semantic aliases that resolve via
        var(--canonical-name) and are validated transitively).
      • If the file holds zero :root blocks at all, that's a structural drift.
    """
    if not path.exists():
        return ([f"file missing: {path}"], [])

    raw = path.read_text()
    if unescape_braces:
        raw = raw.replace("{{", "{").replace("}}", "}")
    raw = _strip_comments(raw)

    # Locate every REAL <style>…</style> region (or, for .css, the whole file).
    # Real-CSS detection masks scripts + HTML comments so a fake <style>
    # smuggled into either can't qualify. We take the slice from the
    # UNMASKED `raw` text afterwards so that `:root { <!-- #deadbe --> }`
    # — an HTML comment hiding raw hex INSIDE a real <style> block — is
    # still visible to the orphan-hex check below.
    real_regions = _real_css_regions(raw, path.suffix)
    if not real_regions:
        return ([f"no `:root {{ … }}` block found in {path.name}"], [])

    bodies: list[str] = []
    for css_start, css_end in real_regions:
        bodies.extend(_extract_root_blocks(raw[css_start:css_end]))

    if not bodies:
        return ([f"no `:root {{ … }}` block found in {path.name}"], [])

    drift: list[str] = []
    stray: list[str] = []

    decl_re = re.compile(
        r"(--[a-z0-9-]+)\s*:\s*([^;]+?)\s*(?:;|$)", re.IGNORECASE
    )
    var_re = re.compile(r"^var\(\s*(--[a-z0-9-]+)\s*\)$")

    for body in bodies:
        for m in decl_re.finditer(body):
            name = m.group(1).lower()
            value = m.group(2).strip()

            # var(--canonical) reference: pass-through if target is canonical.
            if vm := var_re.match(value):
                target = vm.group(1).lower()
                if target not in canonical_by_name:
                    drift.append(
                        f"{name}: var({target}) — target not a canonical token"
                    )
                continue

            canonical = canonical_by_name.get(name)
            if canonical is None:
                # Local aliases like --bg / --surface have no canonical counterpart;
                # accepted only when their value is `var(--canonical-name)`, which
                # the branch above handles. Bare hex with no canonical name is stray.
                stray.append(f"{name} = {value!r} — no canonical counterpart")
                continue

            # Hex: case-insensitive equality with canonical value.
            if _HEX_RE.fullmatch(value):
                if value.lower() != canonical.value:
                    drift.append(
                        f"{name} = {value} — canonical is {canonical.value}"
                    )
                continue

            # Numeric / string: exact whitespace-normalised match.
            normalised = re.sub(r"\s+", " ", value)
            if normalised != canonical.value:
                drift.append(
                    f"{name} = {value!r} — canonical is {canonical.value!r}"
                )

        # Orphan hex inside :root that isn't part of a `--name: value` pair.
        # Without this an attacker stuffs `<style>:root{ raw:#deadbe }</style>`
        # into the file: `decl_re` skips the non-canonical `raw:` form, the
        # body-hex sweep masks the whole :root region, and the hex slips
        # through both checks. Subtract every matched declaration from the
        # body and report any hex left behind.
        residue = decl_re.sub("", body)
        for h in sorted({m.group(0).lower()
                         for m in _HEX_RE.finditer(residue)}):
            stray.append(f"orphan {h} inside :root — not bound to any --token")

    # Body-side hex sweep: lint.sh allowlists css-root mirror files entirely
    # (the :root block is a token source). Without this sweep, a stray
    # `.foo { color: #ff0000 }` in the file body — or a `style="color:#fff"`
    # inline attribute, or a hex literal in JS template strings — would pass
    # both lint and verifier. Mask only the REAL-CSS :root regions and
    # report any remaining hex. (Mask scope matters: an attacker can wrap
    # raw hex in a fake `:root { … }` inside a JS string; restricting masking
    # to <style>-resident :root keeps that hex exposed to the sweep.)
    if body_sweep:
        body_text = _mask_root_regions(raw, path.suffix)
        body_hex = sorted({h.lower() for h in re.findall(r"#[0-9a-fA-F]{3,8}\b", body_text)})
        for h in body_hex:
            stray.append(
                f"{h} found outside :root — css-root mirror bodies must use "
                f"`var(--…)` references only"
            )

    return drift, stray


def extract_mirror_hexes(text: str) -> set[str]:
    """All hex colors a mirror file declares (not in comments)."""
    hexes: set[str] = set()
    for line in text.splitlines():
        # strip line comments — //, #, --
        stripped = re.sub(r"//.*$", "", line)
        stripped = re.sub(r"/\*.*?\*/", "", stripped)
        # Skip the file header comment block — we only care about value bindings,
        # so look for `: '#…'` / `tokenColor("#…")` / `0xFF……` patterns.
        for m in re.finditer(
            r"(?:[\"']#([0-9a-fA-F]{6})\b)|(?:0x[fF]{2}([0-9a-fA-F]{6})\b)",
            stripped,
        ):
            h = (m.group(1) or m.group(2)).lower()
            hexes.add(f"#{h}")
    return hexes


# ─── Main ─────────────────────────────────────────────────────────────────────


def main() -> int:
    if not CSS.exists():
        print(f"fatal: {CSS} not found", file=sys.stderr)
        return 2

    text = CSS.read_text()
    tokens = parse_css(text)
    if not tokens:
        print("fatal: no tokens parsed from tokens.css", file=sys.stderr)
        return 2

    # Build CSS hex set for reverse-direction check
    css_hexes = {t.value for t in tokens if t.kind == "color"}

    print(f"\n\033[1mDesign Tokens Sync\033[0m  (canonical: {CSS.relative_to(ROOT)})")
    print("─" * 60)

    any_drift = False
    summary: dict[str, dict[str, int]] = {}

    canonical_by_name = {t.css_name: t for t in tokens}

    for lang, spec in MIRRORS.items():
        path = spec["path"]
        mirror_type = spec.get("type", "binding")

        # css-root mirrors (apme-dashboard, sd-pi) re-declare a subset of the
        # canonical CSS inside a :root block. They go through a dedicated
        # validator so hex drift inside lint-allowlisted files is caught.
        if mirror_type == "css-root":
            drift_msgs, stray_msgs = verify_css_root_mirror(
                path, canonical_by_name,
                unescape_braces=spec.get("unescape_braces", False),
                body_sweep=spec.get("body_sweep", True),
            )
            if not drift_msgs and not stray_msgs:
                print(f"  \033[32m✓\033[0m  {path.relative_to(ROOT)}  [css-root]")
                continue
            any_drift = True
            bits = []
            if drift_msgs:
                bits.append(f"{len(drift_msgs)} drift")
            if stray_msgs:
                bits.append(f"{len(stray_msgs)} stray")
            print(f"  \033[31m✘\033[0m  {path.relative_to(ROOT)}  [css-root] — {', '.join(bits)}")
            for msg in drift_msgs:
                print(f"      drift:   {msg}")
            for msg in stray_msgs:
                print(f"      stray:   {msg}")
            continue

        kinds = spec["kinds"]
        omit = spec.get("omit", {})
        scope_label = "color-only" if kinds == frozenset({"color"}) else "full"

        if not path.exists():
            print(f"  \033[31m✘\033[0m  {path.relative_to(ROOT)} — file missing")
            any_drift = True
            continue

        # Strip comments once — every binding check operates on the live code,
        # not on commented-out ghost values that would otherwise satisfy the
        # anchored capture and mask drift in the active code below.
        mtext = _strip_comments(path.read_text())
        missing: list[str] = []
        omitted: list[str] = []

        # Build a quick lookup so derivative tokens can resolve their canonical
        # group/key for the reference-binding check.
        by_name = {x.css_name: x for x in tokens}

        # Cache the per-group block once. A binding outside its group block is
        # treated as missing — eliminating the gap where `Ink.s50 = "#f5f3ec"`
        # (Tide value placed inside Ink) used to read as in-sync.
        block_cache: dict[str, str | None] = {}

        def block_for(group: str) -> str | None:
            if group not in block_cache:
                block_cache[group] = _block_for(mtext, group, lang)
            return block_cache[group]

        for t in tokens:
            if t.kind not in kinds:
                continue
            if t.css_name in omit:
                omitted.append(f"{t.css_name} ({omit[t.css_name]})")
                continue

            block = block_for(t.group)
            if block is None:
                missing.append(
                    f"{t.css_name} → {t.group}.{t.key}: group container "
                    f"`{mirror_group_name(t.group, lang)}` not found in mirror"
                )
                continue

            if t.ref is not None:
                target = by_name.get(t.ref)
                if target is None:
                    missing.append(
                        f"{t.css_name} → {t.group}.{t.key}: var() target "
                        f"{t.ref} not found in CSS"
                    )
                    continue
                if not find_reference_binding(
                    block, t.key, target.group, target.key, lang
                ):
                    missing.append(
                        f"{t.css_name} → {t.group}.{t.key}: must reference "
                        f"{target.group}.{target.key} (canonical {t.ref})"
                    )
                continue

            if t.kind == "color":
                if not find_color_binding(block, t.key, t.value, lang):
                    missing.append(f"{t.css_name}={t.value} → expected {t.group}.{t.key}")
            elif t.kind in ("px", "ms", "em"):
                if not find_numeric_binding(block, t.key, t.value, t.kind, lang):
                    missing.append(f"{t.css_name}={t.value}{t.kind} → expected {t.group}.{t.key}")
            elif t.kind == "fontstack":
                families = t.value.split("|") if t.value else []
                gaps = find_fontstack_binding(block, t.key, families, lang)
                if gaps:
                    missing.append(
                        f"{t.css_name} → {t.group}.{t.key}: families not bound "
                        f"to `{t.key}*` keys ({', '.join(gaps)})"
                    )
            elif t.kind == "string":
                if not find_string_binding(block, t.key, t.value, lang):
                    missing.append(
                        f"{t.css_name} → {t.group}.{t.key}: bound value differs "
                        f"from canonical `{t.value[:60]}…`"
                    )

        # Reverse: every hex literal in the live (comment-stripped) code must
        # appear in CSS. Stripping ensures a commented-out hex doesn't both
        # satisfy a forward check AND fail to register here.
        mirror_hexes = extract_mirror_hexes(mtext)
        stray = sorted(mirror_hexes - css_hexes)

        # Per-block reverse stray: any key bound inside a known group block
        # must have a CSS counterpart of that group within the mirror's scope.
        # Catches Spacing.s7, a Tide hex duplicated into Ink as Ink.s50,
        # FontSize.invented, etc. — all silent under prior verifier passes.
        # Font is exempted because the multi-field convention (sansKR, sansJP,
        # monoFallback…) is intentional and not 1:1 with CSS keys.
        expected_keys_per_group: dict[str, set[str]] = {}
        for t in tokens:
            if t.kind not in kinds:
                continue
            if t.css_name in omit:
                continue
            expected_keys_per_group.setdefault(t.group, set()).add(t.key)

        block_stray: list[str] = []
        for group, expected_keys in expected_keys_per_group.items():
            if group == "Font":
                continue
            block = block_for(group)
            if block is None:
                continue
            bound = extract_bound_keys(block, lang)
            for stray_key in sorted(bound - expected_keys):
                block_stray.append(f"{group}.{stray_key}")

        n_missing = len(missing)
        n_stray = len(stray)
        n_block_stray = len(block_stray)
        n_omit = len(omitted)
        summary[lang] = {
            "missing": n_missing,
            "stray": n_stray,
            "block_stray": n_block_stray,
            "omit": n_omit,
        }

        omit_suffix = f" ({n_omit} omit)" if n_omit else ""

        if not n_missing and not n_stray and not n_block_stray:
            print(f"  \033[32m✓\033[0m  {path.relative_to(ROOT)}  [{scope_label}]{omit_suffix}")
            for o in omitted:
                print(f"      omit:    {o}")
            continue

        any_drift = True
        bits = []
        if n_missing:
            bits.append(f"{n_missing} missing")
        if n_stray:
            bits.append(f"{n_stray} stray hex")
        if n_block_stray:
            bits.append(f"{n_block_stray} stray key")
        print(f"  \033[31m✘\033[0m  {path.relative_to(ROOT)}  [{scope_label}]{omit_suffix} — {', '.join(bits)}")
        for m in missing:
            print(f"      missing: {m}")
        for s in stray:
            print(f"      stray hex: {s}  (not in tokens.css)")
        for s in block_stray:
            print(f"      stray key: {s}  (no CSS counterpart in group)")
        for o in omitted:
            print(f"      omit:      {o}")

    print("─" * 60)
    counts = {k: sum(1 for t in tokens if t.kind == k) for k in
              ("color", "px", "ms", "em", "fontstack", "string")}
    parts = [f"{n} {k}" for k, n in counts.items() if n]
    print(
        f"  Checked {' + '.join(parts)} tokens × {len(MIRRORS)} mirrors"
    )

    if any_drift:
        print("\033[31m  Drift detected. Update mirror files or revise tokens.css.\033[0m\n")
        return 1
    print("\033[32m  All mirrors in sync.\033[0m\n")
    return 0


# ─── Self-test ────────────────────────────────────────────────────────────────


def _run_subprocess() -> tuple[int, str]:
    """Spawn the verifier as a subprocess and return (rc, combined_output).
    Used by the self-test so each case runs against the same code path the
    user invokes — no internal state-capture or stdout-redirection tricks.
    """
    import subprocess
    res = subprocess.run(
        [sys.executable, str(Path(__file__).resolve())],
        capture_output=True, text=True,
    )
    return res.returncode, (res.stdout or "") + (res.stderr or "")


def self_test() -> int:
    """Smoke test: mutate a live mirror to inject each silent-drift gap pattern,
    confirm the verifier reports it (rc==1, expected substring in output),
    restore the original. Exits 0 only if every gap is caught.

    Cases — one per gap that previous verifier rounds let through:
      var-swap        — Status.idle pointing at the wrong source token
      group-misplace  — a hex/key bound inside the wrong group's block
      stray-numeric   — a numeric key with no CSS counterpart
      hex-stray       — a colour literal not derived from any CSS token
      comment-mask    — drifted live binding while a commented ghost holds the canonical
    """
    from dataclasses import replace

    js   = MIRRORS["js"]["path"]
    ts   = MIRRORS["ts"]["path"]
    sw   = MIRRORS["swift"]["path"]
    apme = MIRRORS["apme-dashboard"]["path"]
    sdpi = MIRRORS["sd-pi"]["path"]

    Case = tuple[str, Path, callable, str]
    cases: list[Case] = [
        ("var-swap",
         js,
         lambda s: s.replace("idle: Ink.s300,", "idle: Tide.s50,"),
         "must reference Ink.s300"),
        ("group-misplace",
         ts,
         lambda s: s.replace(
             'export const Ink = {\n  s900: "#0e1f1f",',
             'export const Ink = {\n  s50: "#f5f3ec",\n  s900: "#0e1f1f",',
         ),
         "stray key: Ink.s50"),
        ("stray-numeric",
         ts,
         lambda s: s.replace(
             "export const Spacing = {\n  s1: 4,",
             "export const Spacing = {\n  s7: 28,\n  s1: 4,",
         ),
         "stray key: Spacing.s7"),
        ("hex-stray",
         ts,
         lambda s: s.replace('s50: "#f5f3ec",', 's50: "#deadbe",'),
         "stray hex: #deadbe"),
        ("comment-mask",
         sw,
         lambda s: s.replace(
             'static let s50  = tokenColor("#f5f3ec")',
             '/* static let s50 = tokenColor("#f5f3ec") */\n'
             '        static let s50  = tokenColor("#deadbe")',
         ),
         "stray hex: #deadbe"),
        ("css-root-drift",
         apme,
         lambda s: s.replace("--ink-800:#15302f;", "--ink-800:#deadbe;"),
         "--ink-800 = #deadbe — canonical is #15302f"),
        ("css-root-stray",
         sdpi,
         lambda s: s + "\n:root { --bogus: #ff00ff; }\n",
         "--bogus = '#ff00ff' — no canonical counterpart"),
        ("css-root-body-hex",
         apme,
         lambda s: s.replace(
             "</style>",
             ".bogus{color:#ff00ff;background:#ff8800}</style>",
             1,
         ),
         "#ff00ff found outside :root"),
        ("css-root-inline-style",
         apme,
         lambda s: s.replace(
             "<body>",
             '<body>\n<div style="background:#deadbe">stray</div>',
             1,
         ),
         "#deadbe found outside :root"),
        # Attack pattern: wrap raw hex in a fake `:root { … }` inside a JS
        # string. Earlier sweep masked any :root region anywhere in the file
        # → hex hidden. Real-CSS-only masking keeps it exposed.
        ("css-root-fake-block",
         apme,
         lambda s: s.replace(
             "<body>",
             "<body>\n<script>const fake=':root{--ink-900:#deadbe;}';</script>",
             1,
         ),
         "#deadbe found outside :root"),
        # Deeper attack: stuff hex inside a fake `<style>:root{ … }</style>`
        # held in a JS template string. Without script-body masking, the
        # `<style>` regex grabs the fake region as real CSS, then the :root
        # mask hides the hex. Validator can't catch it because the content
        # has no `--name:` prefix.
        ("css-root-fake-style-in-script",
         apme,
         lambda s: s.replace(
             "<body>",
             "<body>\n<script>const x = '<style>:root{ raw:#deadbe }</style>';</script>",
             1,
         ),
         "#deadbe found outside :root"),
        # HTML-comment-wrapped fake style. Without HTML-comment masking in
        # `_real_css_regions`, the embedded `<style>` qualifies as real CSS
        # and the :root mask hides the hex. Body sweep still scans the
        # comment region (HTML comments are NOT stripped by `_strip_comments`),
        # so the hex stays visible there.
        ("css-root-html-comment-fake-style",
         apme,
         lambda s: s.replace(
             "<body>",
             "<body>\n<!-- <style>:root{ raw:#deadbe }</style> -->",
             1,
         ),
         "#deadbe found outside :root"),
        # Orphan hex inside a real :root block (no `--name:` form). Validator
        # used to skip non-declaration content and the mask used to swallow
        # the whole :root body. The new orphan-hex-in-:root sweep flags it.
        ("css-root-orphan-hex-in-root",
         apme,
         lambda s: s.replace(
             "</style>",
             "}\n:root{ raw:#deadbe }\n</style>",
             1,
         ),
         "orphan #deadbe inside :root"),
        # HTML comment INSIDE a real :root block — the previous flow extracted
        # bodies from a comment-masked CSS string, so `<!-- raw:#deadbe -->`
        # vanished before the orphan-hex check ran. Now bodies come from the
        # unmasked region slice so the comment content stays visible.
        ("css-root-html-comment-in-root",
         apme,
         lambda s: s.replace(
             "--ink-800:#15302f;",
             "--ink-800:#15302f;<!-- raw:#deadbe -->",
             1,
         ),
         "orphan #deadbe inside :root"),
    ]

    failures: list[str] = []
    for name, path, mutate, expected in cases:
        original = path.read_text()
        try:
            mutated = mutate(original)
            if mutated == original:
                failures.append(f"{name}: mutation produced no change (stale fixture)")
                continue
            path.write_text(mutated)
            rc, output = _run_subprocess()
            if rc == 0:
                failures.append(f"{name}: verifier returned 0 (drift undetected)")
                continue
            if expected not in output:
                failures.append(
                    f"{name}: rc={rc} but expected substring `{expected}` "
                    f"missing from output"
                )
        finally:
            path.write_text(original)

    print(f"\n\033[1mSelf-test\033[0m  ({len(cases)} silent-drift gap patterns)")
    print("─" * 60)
    if failures:
        for f in failures:
            print(f"  \033[31m✘\033[0m  {f}")
        print(f"\n\033[31m  {len(failures)} of {len(cases)} cases failed.\033[0m\n")
        return 1
    for name, *_ in cases:
        print(f"  \033[32m✓\033[0m  {name}")
    print("\n\033[32m  All gap patterns caught.\033[0m\n")
    return 0


if __name__ == "__main__":
    if "--self-test" in sys.argv[1:]:
        raise SystemExit(self_test())
    raise SystemExit(main())
