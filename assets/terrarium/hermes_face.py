"""Hermes (Nous girl) face design — the single 2D source for the 3D face.

The face is designed here, in head units (x right, y up, origin at the head
joint), and reviewed as a flat sheet before any mesh exists. The Blender builder
imports the same shapes, so what is approved on the sheet is what lands on the
model. Proportions follow the approved concept's front face (a round face with
full cheeks and a short lower face; large almond eyes low under the fringe; a
small nose shadow; small full lips close to the chin). The expression follows
the official mark: heavy upper lid, bold liner with an outward wing, fine lower
lash line.

Run standalone to write the review sheet:
    python3 assets/terrarium/hermes_face.py <out-dir>
"""
import math, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# ---- proportions (head units) -------------------------------------------
HEM_Y = .020                  # fringe hem (the face above it is under hair)
FACE_W = .160                 # half-width at the cheeks
CHIN_Y = -.210
EYE_Y, EYE_X = -.052, .076    # eye centre; x is the centre of the right eye
EW, EH_T, EH_B = .094, .030, .023
IRIS_R = (.029, .034); IRIS_Y = .002   # high under the lid, as in the mark        # relative to the eye centre
NOSE_Y = -.100
MOUTH_Y = -.133

def smooth(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a))); return t * t * (3 - 2 * t)

def bezier(p0, p1, p2, p3, n=24):
    return [tuple((1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t * t * c + t ** 3 * d
                  for a, b, c, d in zip(p0, p1, p2, p3)) for t in (i / n for i in range(n + 1))]

def face_outline():
    """Front silhouette: an oval with soft cheeks narrowing to the mark's gently pointed chin."""
    # The mark's jaw: a long, nearly straight line from under the cheekbone to a
    # small soft chin, not a round cheek that turns late into a point.
    right = (bezier((FACE_W * .97, .080), (FACE_W * 1.01, .010), (FACE_W * 1.00, -.045), (FACE_W * .93, -.090))
             + bezier((FACE_W * .93, -.090), (FACE_W * .70, -.140), (.040, CHIN_Y + .004), (0, CHIN_Y))[1:])
    left = [(-x, y) for x, y in reversed(right)]
    return right + left[1:]

def half_width(y):
    """Face half-width at height y, from the outline (used to shape the mesh)."""
    pts = face_outline(); pts = [p for p in pts if p[0] >= 0]
    pts.sort(key=lambda p: -p[1])
    if y >= pts[0][1]: return pts[0][0]
    if y <= pts[-1][1]: return 0.0
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        if y0 >= y >= y1: return x0 + (x1 - x0) * (y - y0) / ((y1 - y0) or 1e-9)
    return 0.0

# ---- eyes (relative to each eye centre; s=+1 right eye, -1 left eye) ------
def top_arc(t, s):   # t=0 inner corner, t=1 outer corner
    x = s * (t - .5) * EW
    return (x, EH_T * max(0, math.sin(math.pi * t)) ** .50 + .005 * (t - .5))
def bot_arc(t, s):
    x = s * (t - .5) * EW
    return (x, -EH_B * max(0, math.sin(math.pi * t)) ** .72 + .004 * (t - .5))
def almond(s, n=32):
    return [top_arc(i / n, s) for i in range(n + 1)] + [bot_arc(i / n, s) for i in range(n, -1, -1)][1:-1]

def ribbon(center, width, n=28):
    top, bot = [], []
    for i in range(n + 1):
        t = i / n; x, y = center(t); x2, y2 = center(min(1, t + 1e-3)); x1, y1 = center(max(0, t - 1e-3))
        dx, dy = x2 - x1, y2 - y1; L = math.hypot(dx, dy) or 1; nx, ny = -dy / L, dx / L
        w = width(t) / 2; top.append((x + nx * w, y + ny * w)); bot.append((x - nx * w, y - ny * w))
    return top + bot[::-1]

def upper_liner(s):
    """The mark's upper lashes are one heavy ink mass over the lid, thickest at the
    outer third, ending in a few spiky lashes that fan out and up."""
    n = 36
    thick = lambda t: .0060 + .0110 * smooth(.05, .85, t) * (1 - .30 * smooth(.9, 1, t))   # the concept's bold liner
    upper = [(top_arc(t, s)[0] * 1.01, top_arc(t, s)[1] + thick(t)) for t in (i / n for i in range(n + 1))]
    cx, cy = top_arc(1, s)
    tip = (cx + s * .024, cy + .013)
    lid = [top_arc(t, s) for t in ((n - i) / n for i in range(n + 1))]
    return upper + [tip] + lid

def lash_spikes(s):
    """Separate outer lashes: short tapered spikes past the outer corner."""
    out = []
    for t0, ang, ln in ((.80, 1.15, .012), (.90, .75, .015), (.98, .38, .016)):
        x, y = top_arc(t0, s); y += .010 * smooth(.05, .85, t0)
        a = math.pi / 2 - ang
        dx, dy = s * math.cos(a) * ln, math.sin(a) * ln
        w = .0028; nx, ny = -dy / ln * w, dx / ln * w
        out.append([(x - nx, y - ny), (x + dx, y + dy), (x + nx, y + ny)])
    return out

def lower_lash(s):
    """A fine lower lash line on the outer half with small downward spikes."""
    c = lambda t: (bot_arc(.40 + .60 * t, s)[0], bot_arc(.40 + .60 * t, s)[1] - .0010)
    pts = ribbon(c, lambda t: .0018 * math.sin(math.pi * t) ** .7 + .0003, 20)
    return pts

def lower_spikes(s):
    out = []
    for t0 in (.62, .74, .86):
        x, y = bot_arc(t0, s); y -= .001
        ln = .0045; dx, dy = s * .0022, -ln
        out.append([(x - s * .0012, y), (x + dx, y + dy), (x + s * .0014, y)])
    return out

def closed_lid(s):
    def c(t):
        if t <= .86:
            u = t / .86; return (s * (u - .5) * EW, -.011 * math.sin(math.pi * u) - .002)
        u = (t - .86) / .14; return (s * (EW * .5 + .015 * u), -.002 + .007 * u)
    return ribbon(c, lambda t: .0035 + .0045 * math.sin(math.pi * min(t / .86, 1)) * (1 - smooth(.9, 1, t)) + .0005, 30)

def clip_to_almond(pts, s, inset=.0012):
    out = []
    for x, y in pts:
        t = s * x / EW + .5
        if t <= 0 or t >= 1: out.append((x, 0)); continue
        out.append((x, max(bot_arc(t, s)[1] + inset, min(top_arc(t, s)[1] - inset * 2, y))))
    return out

def ellipse(cx, cy, rx, ry, n=36):
    return [(cx + math.cos(2 * math.pi * i / n) * rx, cy + math.sin(2 * math.pi * i / n) * ry) for i in range(n)]

def lid_shadow(s):  # the upper lid's soft shadow across the eye white
    return [top_arc(i / 24, s) for i in range(25)] + [(x, y - .009 * math.sin(math.pi * i / 24)) for i, (x, y) in reversed(list(enumerate(top_arc(i / 24, s) for i in range(25))))]
def iris(s):   return clip_to_almond(ellipse(0, IRIS_Y, *IRIS_R, 40), s)
def iris_glow(s):  # faint lighter lower crescent of the iris
    return clip_to_almond(ellipse(0, IRIS_Y - .014, IRIS_R[0] * .70, IRIS_R[1] * .34, 32), s)
def pupil(s):  return clip_to_almond(ellipse(0, IRIS_Y + .002, .012, .016, 28), s)
def glint(s):  return ellipse(s * .009, .006, .0060, .0064, 20)   # upper outer, as in the mark
def glint_small(s): return ellipse(.011, -.015, .0024, .0024, 14)

# ---- nose and mouth --------------------------------------------------------
def nose():
    """The mark's nose from the front: one small hooked nostril stroke on the shaded side."""
    def c(t):
        a = math.pi * (.15 + 1.0 * t)
        return (-.004 + .0065 * math.cos(a), NOSE_Y + .0035 * math.sin(a) - .0015)
    return ribbon(c, lambda t: .0026 * math.sin(math.pi * t) ** .5 + .0004, 18)

LIP_W = .048
def lip_upper():   # relative to the mouth control: a dark M-shaped upper lip
    def top(t):
        u = 2 * (t - .5)
        return ((t - .5) * LIP_W, .0045 * (1 - u * u) ** .7 - .0020 * math.exp(-(u / .16) ** 2) + .0006)
    bottom = lambda t: ((t - .5) * LIP_W * .96, -.0006 * (1 - (2 * (t - .5)) ** 2))
    n = 28
    return [top(i / n) for i in range(n + 1)] + [bottom(1 - i / n) for i in range(1, n)]
def lip_line():
    return ribbon(lambda t: ((t - .5) * LIP_W * .98, -.0010 + .0012 * (2 * (t - .5)) ** 2), lambda t: .0018 * math.sin(math.pi * t) ** .35 + .0004, 28)
def lip_lower():   # fuller lower lip, a soft tone with a darker rim
    n = 24
    top = [((t - .5) * LIP_W * .78, -.0022) for t in (i / n for i in range(n + 1))]
    bot = [((t - .5) * LIP_W * .78, -.0022 - .0095 * math.sin(math.pi * t) ** .75) for t in (1 - i / n for i in range(1, n))]
    return top + bot
def lip_lower_rim():
    return ribbon(lambda t: ((t - .5) * LIP_W * .70, -.0022 - .0095 * math.sin(math.pi * t) ** .75), lambda t: .0016 * math.sin(math.pi * t) ** .6 + .0002, 24)
def mouth_open(): return ellipse(0, -.004, .012, .007, 24)

BROW_Y = .001   # just under the fringe hem, above the lash line
def brow(s):  # fine, softly arched brows, slightly higher at the inner end
    return ribbon(lambda t: (s * ((t - .5) * .052 + .002), .0045 * math.sin(math.pi * t ** .85) - .003 * t), lambda t: .0046 * math.sin(math.pi * t) ** .55 + .0005, 16)

# ---- palette (design tokens only) -----------------------------------------
_tokens = (ROOT / 'design/tokens.css').read_text()
def token(name): return '#' + re.search(r'--' + name + r':\s*#([0-9a-fA-F]{6})', _tokens).group(1)
def neutral(name, gain=1.0):
    """The Nous girl is monochrome, but the ink tokens are green-tinted: keep the
    token's lightness, drop its hue."""
    h = token(name)[1:]; r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    v = max(0, min(255, round((.2126 * r + .7152 * g + .0722 * b) * gain)))
    return f'#{v:02x}{v:02x}{v:02x}'
PALETTE = {'skin': token('tide-100'), 'white': token('tide-50'), 'line': neutral('ink-900', .7), 'iris': neutral('ink-800', .40),
           'glow': neutral('ink-800', .55), 'lip': neutral('ink-500', 1.15), 'lip_dark': neutral('ink-900', .9),
           'shade': neutral('ink-500', 1.25), 'lid_shadow': neutral('tide-200', .88), 'hair': neutral('ink-900', .7)}

def layers():
    """(name, colour key, polygon in head units) — in paint order."""
    L = [('face', 'skin', face_outline()), ('nose_shadow', 'shade', nose())]
    for s, lab in ((-1, 'left'), (1, 'right')):
        o = lambda pts, s=s: [(x + s * EYE_X, y + EYE_Y) for x, y in pts]
        L += [(f'sclera_{lab}', 'white', o(almond(s))), (f'lid_shadow_{lab}', 'lid_shadow', o(lid_shadow(s))), (f'iris_{lab}', 'iris', o(iris(s))), (f'iris_glow_{lab}', 'glow', o(iris_glow(s))),
              (f'pupil_{lab}', 'line', o(pupil(s))), (f'highlight_{lab}', 'white', o(glint(s))), (f'highlight_small_{lab}', 'white', o(glint_small(s))),
              (f'lower_lash_{lab}', 'line', o(lower_lash(s))), (f'upper_lash_{lab}', 'line', o(upper_liner(s)))]
        L += [(f'eyebrow_{lab}', 'line', [(x + s * .076, y + BROW_Y) for x, y in brow(s)])]
        L += [(f'lash_spike_{lab}_{i}', 'line', o(p)) for i, p in enumerate(lash_spikes(s))]
        L += [(f'lower_spike_{lab}_{i}', 'line', o(p)) for i, p in enumerate(lower_spikes(s))]
    m = lambda pts: [(x, y + MOUTH_Y) for x, y in pts]
    L += [('lip_lower', 'lip', m(lip_lower())), ('lip_lower_rim', 'lip_dark', m(lip_lower_rim())),
          ('lip_upper', 'lip_dark', m(lip_upper())), ('lip_line', 'line', m(lip_line()))]
    return L

def svg(extra=None, scale=2400, blink=False, hem=True):
    """Front sheet. `blink` swaps the open eyes for closed lids."""
    x0, y0, w, h = -.21, -.23, .42, .30
    P = lambda pts: ' '.join(f'{(x - x0) * scale:.1f},{(y0 + h - y) * scale:.1f}' for x, y in pts)
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{w * scale:.0f}" height="{h * scale:.0f}">',
             f'<rect width="100%" height="100%" fill="#0b1a24"/>']
    for name, col, pts in layers():
        if blink and any(name.startswith(k) for k in ('sclera', 'lid_shadow', 'iris', 'pupil', 'highlight', 'lower_lash', 'upper_lash', 'lash_spike', 'lower_spike')): continue
        parts.append(f'<polygon id="{name}" points="{P(pts)}" fill="{PALETTE[col]}"/>')
    if blink:
        for s in (-1, 1):
            parts.append(f'<polygon points="{P([(x + s * EYE_X, y + EYE_Y) for x, y in closed_lid(s)])}" fill="{PALETTE["line"]}"/>')
    if hem:  # the fringe hem and side curtains, so proportions are judged inside the hair frame
        parts.append(f'<rect x="0" y="0" width="{w * scale:.0f}" height="{(y0 + h - HEM_Y) * scale:.0f}" fill="{PALETTE["hair"]}"/>')
        for s_ in (-1, 1):
            curtain = [(s_ * FACE_W * .84, HEM_Y + .01), (s_ * FACE_W * .88, -.060), (s_ * FACE_W * .95, -.150), (s_ * FACE_W * 1.20, -.205),
                       (s_ * FACE_W * 1.45, -.190), (s_ * FACE_W * 1.35, -.120), (s_ * FACE_W * 1.30, HEM_Y + .01)]
            parts.append(f'<polygon points="{P(curtain)}" fill="{PALETTE["hair"]}"/>')
    parts.append('</svg>')
    return '\n'.join(parts)

if __name__ == '__main__':
    out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
    (out / 'face-front.svg').write_text(svg())
    (out / 'face-blink.svg').write_text(svg(blink=True))
    print('wrote', out)
