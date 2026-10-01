"""Face sheet v2: the v18 face drawing code (`assets/terrarium/hermes_face.py`)
with proportions re-measured from the current guide.

The guide is the head-study front (`ref/front.png`, candidate-02: the master
concept's face turned to the front). The master camera fit agrees with its
feature placement. Each value below was read off that image on a 20 px grid
(2026-10-01) and converted to head units. The conversion puts the sheet hem
(0.020) on the model bang line (z 1.86) and uses 1 head unit = 8.696 model
units, so the sheet chin (-0.210) lands on the model chin (z -0.14).

What changed from v18, and why:
- Eyes: higher (-0.036 vs -0.052) and wider apart (0.100 vs 0.076). The guide
  has its eyes just under the fringe, the widest spacing of any version.
- Iris: smaller (0.024 x 0.028 vs 0.029 x 0.034), set 0.010 toward the nose
  so she looks at the viewer, and sized (0.027 x 0.031) so it fills the eye
  height with the heavy upper lid clipping its top, as the master draws it.
  At its first measured height (centred) the RealityKit render read as
  wide-eyed surprise.
- Eye top: the guide's "upper lid" edge (0.032) is the TOP of its liner band.
  v18 draws the liner above the lid line, so the lid line is 0.024 and the
  liner is thinned to the guide's weight (upper_liner below). Before this
  fix, the brows collided with the liner and showed only as dashes in
  RealityKit.
- Brows: long, fine arcs in the gap between the liner and the hem
  (BROW_Y 0.010, x 0.100, length 0.080).
- Mouth: a little wider (0.056). Nose and mouth heights are unchanged within
  0.004.

The drawing code is loaded from v18 and never copied, so one implementation
serves both versions. Only the functions whose placement v18 hard-coded are
replaced: the brow x, and the iris / pupil / glint offset.
"""
import math, sys, types
from pathlib import Path

_SRC = Path(__file__).resolve().parents[1] / "hermes_face.py"
F = types.ModuleType("hermes_face_v2")
F.__file__ = str(_SRC)
exec(compile(_SRC.read_text(), str(_SRC), "exec"), F.__dict__)

# ---- measured proportions (head units) -----------------------------------
F.EYE_X, F.EYE_Y = 0.098, -0.036   # sheet iris centres at x +-0.9 model units
F.EW, F.EH_T, F.EH_B = 0.079, 0.025, 0.024   # 2026-10-02: eye width / face width 0.30 -> the sheet's ~0.24; almond h/w ~0.62
F.IRIS_R, F.IRIS_Y = (0.024, 0.028), 0.003
IRIS_DX = 0.010            # toward the nose
F.BROW_Y, BROW_X, BROW_LEN = 0.020, 0.098, 0.080   # in the gap between the liner top (~z 1.69) and the hem (1.84)
F.NOSE_Y, F.MOUTH_Y, F.LIP_W = -0.099, -0.131, 0.052   # sheet overlay: lips sat ~0.12 units low
F.MODEL_HEM_Z, F.MODEL_CHIN_Z, F.MODEL_SCALE = 1.86, -0.14, 8.696


def _shift(pts, dx):
    return [(x + dx, y) for x, y in pts]


def iris(s):
    return F.clip_to_almond(F.ellipse(-s * IRIS_DX, F.IRIS_Y, *F.IRIS_R, 40), s)


def iris_glow(s):
    # ref: a soft lighter crescent low in the iris (lum ~60-90), well inside its rim
    return F.clip_to_almond(F.ellipse(-s * IRIS_DX, F.IRIS_Y - .017, F.IRIS_R[0] * .62, F.IRIS_R[1] * .36, 32), s)


def pupil(s):
    """The sheet shows no distinct pupil: the iris is darkest under the lid and
    lightens downward. So the dark layer is the iris's upper ~60%, not a dot
    (a round pupil read as a doll's eye in RealityKit)."""
    return F.clip_to_almond(F.ellipse(-s * IRIS_DX, F.IRIS_Y + .010, F.IRIS_R[0] * .90, F.IRIS_R[1] * .62, 32), s)


def glint(s):
    # ref: one round highlight, upper-LEFT in both eyes (one light), not mirrored
    return F.ellipse(-s * IRIS_DX - .011, .010, .0055, .0058, 20)


def glint_small(s):
    return F.ellipse(-s * IRIS_DX + .010, -.014, .0012, .0012, 10)


def crease(s):
    """The thin double-eyelid crease line the ref draws above the liner."""
    return F.ribbon(lambda t: (F.top_arc(.12 + .80 * t, s)[0] * 1.02, F.top_arc(.12 + .80 * t, s)[1] + .0165 + .002 * F.math.sin(F.math.pi * t)),
                    lambda t: .0016 * F.math.sin(F.math.pi * t) ** .6 + .0003, 24)


def upper_liner(s):
    """v18's liner mass at the guide's weight: the guide's liner band is ~0.008-0.012
    thick, v18 drew up to 0.017 on top of a lid line that was itself measured at the
    liner's top edge, so the eye opening rode too high and the brows collided with it."""
    n = 36
    thick = lambda t: .0085 + .0070 * F.smooth(.05, .85, t) * (1 - .30 * F.smooth(.9, 1, t))   # ref: solid band ~0.0115 across the eye
    upper = [(F.top_arc(t, s)[0] * 1.01, F.top_arc(t, s)[1] + thick(t)) for t in (i / n for i in range(n + 1))]
    cx, cy = F.top_arc(1, s)
    tip = (cx + s * .022, cy + .011)
    lid = [F.top_arc(t, s) for t in ((n - i) / n for i in range(n + 1))]
    return upper + [tip] + lid


def lip_upper():
    """Fuller M-shaped upper lip: the sheet's upper lip is as tall as the lower
    (~0.008 head units); v18's 0.0045 read as a thin grey line in RealityKit."""
    def top(t):
        u = 2 * (t - .5)
        return ((t - .5) * F.LIP_W, .0078 * (1 - u * u) ** .6 - .0030 * math.exp(-(u / .18) ** 2) + .0006)
    bottom = lambda t: ((t - .5) * F.LIP_W * .96, -.0006 * (1 - (2 * (t - .5)) ** 2))
    n = 28
    return [top(i / n) for i in range(n + 1)] + [bottom(1 - i / n) for i in range(1, n)]


def brow(s):
    """Long fine arcs, slightly higher at the inner end (placed at +-BROW_X)."""
    return F.ribbon(lambda t: (s * (t - .5) * BROW_LEN, .0040 * math.sin(math.pi * t ** .85) - .0025 * t),
                    lambda t: .0017 * math.sin(math.pi * t) ** .55 + .0003, 16)   # very fine: the sheets barely show brows under the fringe


def layers():
    L = [('face', 'skin', F.face_outline()), ('nose_shadow', 'shade', F.nose())]
    for s, lab in ((-1, 'left'), (1, 'right')):
        o = lambda pts, s=s: [(x + s * F.EYE_X, y + F.EYE_Y) for x, y in pts]
        L += [(f'sclera_{lab}', 'white', o(F.almond(s))), (f'lid_shadow_{lab}', 'lid_shadow', o(F.lid_shadow(s))),
              (f'iris_{lab}', 'iris', o(iris(s))), (f'iris_glow_{lab}', 'glow', o(iris_glow(s))),
              (f'pupil_{lab}', 'line', o(pupil(s))), (f'highlight_{lab}', 'white', o(glint(s))),
              (f'highlight_small_{lab}', 'white', o(glint_small(s))),
              (f'lower_lash_{lab}', 'line', o(F.lower_lash(s))), (f'upper_lash_{lab}', 'line', o(F.upper_liner(s)))]
        L += [(f'eyebrow_{lab}', 'line', [(x + s * BROW_X, y + F.BROW_Y) for x, y in brow(s)])]
        L += [(f'lash_spike_{lab}_{i}', 'line', o(p)) for i, p in enumerate(F.lash_spikes(s))]
        L += [(f'lower_spike_{lab}_{i}', 'line', o(p)) for i, p in enumerate(F.lower_spikes(s))]
    m = lambda pts: [(x, y + F.MOUTH_Y) for x, y in pts]
    L += [('lip_lower', 'lip', m(F.lip_lower())), ('lip_lower_rim', 'lip_dark', m(F.lip_lower_rim())),
          ('lip_upper', 'lip_dark', m(lip_upper())), ('lip_line', 'line', m(F.lip_line()))]
    return L


F.iris, F.iris_glow, F.pupil, F.glint, F.glint_small, F.brow, F.layers = iris, iris_glow, pupil, glint, glint_small, brow, layers
F.upper_liner = upper_liner
F.lip_upper = lip_upper
F.BROW_X, F.IRIS_DX, F.BROW_LEN = BROW_X, IRIS_DX, BROW_LEN
# lips sampled from the front sheet: upper lip mauve-grey ~140/128/130, lower
# lip lighter pinkish grey ~205/185/182 (its rim ~175/158/158)
F.PALETTE = dict(F.PALETTE, lip='#c4ada9', lip_dark='#74686b',
                 iris='#1d1f26', glow='#3b404b')   # master: dark navy iris, lighter only low   # RealityKit lifts these: rendered iris top then matches the sheet's ~20-40   # ref iris: dark top ~20, lower half ~60-90 grey-blue
F.crease = crease
sys.modules["hermes_face_v2"] = F
