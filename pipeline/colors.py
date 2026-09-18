"""Dominant-colour extraction for album artwork.

The app draws an animated gradient progress bar from ``album.colors`` —
``{"primary": "#rrggbb", "secondary": "#rrggbb"}``. That imposes three rules
this module has to guarantee, no matter what the sleeve looks like:

1. **Never null.** Both keys are always present and always a valid hex string.
2. **Never collapsed.** A single-colour sleeve (or an almost-white one like the
   White Album) still yields two *visibly different* colours, so the gradient
   reads as a gradient and not as a flat bar. The separation is checked on the
   colours that actually ship, after contrast correction, not before it.
3. **Never invisible.** The UI background is dark. Both colours are lifted, if
   needed, until each clears **3:1 contrast against ``#121212``** — the WCAG
   2.1 1.4.11 minimum for a non-text UI component, which is exactly what a
   progress bar is. Lifting happens in HLS so hue and saturation survive.

Distances are measured as CIE76 ΔE in CIE-Lab, not in RGB: RGB distance badly
misjudges how different two colours *look*, which is the only thing that
matters for "does this look like a gradient".

One deliberate departure from "the two most common colours": sleeves are
scanned with a white border and plenty of covers are a photograph floating in
white space, so plain white or grey routinely wins on pixel count for a record
that is not remotely white. **Both ends of the pair are therefore drawn from
the sleeve's real colours before greyscale is considered at all.** Taking only
the primary from them is not enough — it just moves the white into the other
slot, and gold-to-white is a beige smear exactly like white-to-gold. A sleeve
with no real colour on it gets a greyscale pair, which for the White Album or
*Madvillainy* is the honest answer.

Every album reports which rule fired as ``color_strategy``, so this stays
auditable against the artwork later.
"""

from __future__ import annotations

import colorsys
import io
from dataclasses import dataclass

# --------------------------------------------------------------------------
# Tunables (documented in pipeline/README.md)
# --------------------------------------------------------------------------

UI_BACKGROUND = "#121212"
MIN_CONTRAST = 3.0          # WCAG 2.1 SC 1.4.11, non-text UI component
MIN_DELTA_E = 18.0          # below this the two swatches read as one colour
DERIVED_HUE_SHIFT = 0.035       # ~12 degrees, keeps a derived pair related
#: Lightness offsets tried, in order, when deriving a partner colour.
DERIVED_STEPS = (0.22, 0.30, 0.38, 0.47, 0.57, 0.68, 0.80)
#: Colourfulness is measured as **CIE-Lab chroma**, sqrt(a²+b²), not HLS
#: saturation — see :func:`is_color`. At 13 a colour is unmistakably a colour
#: (dark brown 13.7, pale gold 18.9, gold 72); a muted blue-grey photograph
#: sits at 10 and is correctly excluded.
CHROMA_MIN = 13.0
#: Below this there is no hue worth carrying; the sleeve is greyscale.
CHROMA_TINT = 5.0
#: Hue is not trustworthy at the very ends of the lightness range. A cluster
#: this dark is black with quantization noise on it, however confidently that
#: noise claims to be cyan; this light is paper.
CHROMA_LIGHTNESS_MIN = 0.06
CHROMA_LIGHTNESS_MAX = 0.95
#: 1.5% of a 500px sleeve is ~3,750 pixels — a title bar or a logo, not a speck.
CHROMATIC_WEIGHT = 0.015
#: Leading the pair is a stronger claim than partnering it, so it needs more of
#: the sleeve behind it: a 2% logo can colour the gradient, not headline it.
CHROMATIC_LEAD_WEIGHT = 0.04

# Strategy labels, reported per album as ``color_strategy``.
SATURATED = "saturated"                  # both ends are real colours off the sleeve
SATURATED_DERIVED = "saturated-derived"  # one real colour leads; partner tinted from it
SATURATED_PARTNER = "saturated-partner"  # greyscale leader, small colour partners it
DOMINANT = "dominant"                    # greyscale sleeve: two most common colours
DERIVED = "derived"                      # one usable colour; partner synthesized
NEUTRAL_FALLBACK = "neutral-fallback"    # no artwork at all
QUANTIZE_COLORS = 16
SAMPLE_SIZE = 120           # thumbnail edge, px — plenty for dominant colour

_LUM_CACHE: dict[tuple[int, int, int], float] = {}


@dataclass(frozen=True)
class ColorPair:
    primary: str
    secondary: str
    #: How the pair was arrived at: one of DOMINANT, SATURATED_PRIMARY,
    #: SATURATED_PARTNER, DERIVED, NEUTRAL_FALLBACK. Shipped per album as
    #: ``color_strategy`` so these rules stay auditable after the fact.
    strategy: str = DOMINANT
    #: True when a colour had to be lightened to clear the contrast floor.
    adjusted: bool = False

    def as_dict(self) -> dict:
        return {"primary": self.primary, "secondary": self.secondary}


# --------------------------------------------------------------------------
# Colour space helpers
# --------------------------------------------------------------------------

def hex_to_rgb(value: str) -> tuple[int, int, int]:
    s = value.strip().lstrip("#")
    if len(s) == 3:
        s = "".join(c * 2 for c in s)
    if len(s) != 6:
        raise ValueError(f"not a hex colour: {value!r}")
    return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]


def rgb_to_hex(rgb: tuple[int, int, int]) -> str:
    r, g, b = (max(0, min(255, int(round(c)))) for c in rgb)
    return f"#{r:02x}{g:02x}{b:02x}"


def _linear(channel: float) -> float:
    c = channel / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def relative_luminance(rgb: tuple[int, int, int]) -> float:
    """WCAG relative luminance, 0.0 (black) .. 1.0 (white)."""
    key = tuple(int(c) for c in rgb)
    cached = _LUM_CACHE.get(key)  # type: ignore[arg-type]
    if cached is None:
        r, g, b = (_linear(c) for c in key)
        cached = 0.2126 * r + 0.7152 * g + 0.0722 * b
        _LUM_CACHE[key] = cached  # type: ignore[index]
    return cached


def contrast_ratio(a: tuple[int, int, int], b: tuple[int, int, int]) -> float:
    la, lb = relative_luminance(a), relative_luminance(b)
    hi, lo = (la, lb) if la >= lb else (lb, la)
    return (hi + 0.05) / (lo + 0.05)


def _rgb_to_lab(rgb: tuple[int, int, int]) -> tuple[float, float, float]:
    r, g, b = (_linear(c) for c in rgb)
    # sRGB -> XYZ (D65)
    x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047
    y = (0.2126729 * r + 0.7151522 * g + 0.0721750 * b) / 1.00000
    z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883

    def f(t: float) -> float:
        return t ** (1.0 / 3.0) if t > 0.008856 else (7.787 * t) + (16.0 / 116.0)

    fx, fy, fz = f(x), f(y), f(z)
    return (116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz))


def delta_e(a: tuple[int, int, int], b: tuple[int, int, int]) -> float:
    """CIE76 colour difference. ~2.3 is 'just noticeable'; 18 is 'obviously different'."""
    la, aa, ba = _rgb_to_lab(a)
    lb, ab, bb = _rgb_to_lab(b)
    return ((la - lb) ** 2 + (aa - ab) ** 2 + (ba - bb) ** 2) ** 0.5


# --------------------------------------------------------------------------
# Contrast enforcement
# --------------------------------------------------------------------------

def ensure_contrast(rgb: tuple[int, int, int], background: str = UI_BACKGROUND,
                    minimum: float = MIN_CONTRAST) -> tuple[tuple[int, int, int], bool]:
    """Lighten ``rgb`` in HLS until it clears ``minimum`` contrast on ``background``.

    Returns ``(rgb, adjusted)``. Hue and saturation are preserved; only
    lightness moves, so a deep navy sleeve stays navy and does not turn grey.
    """
    bg = hex_to_rgb(background)
    if contrast_ratio(rgb, bg) >= minimum:
        return rgb, False

    h, l, s = colorsys.rgb_to_hls(*(c / 255.0 for c in rgb))
    # A pure black pixel has no hue to preserve; give it a neutral grey ramp.
    for _ in range(60):
        l = min(1.0, l + 0.02)
        cand = tuple(int(round(c * 255)) for c in colorsys.hls_to_rgb(h, l, s))
        if contrast_ratio(cand, bg) >= minimum:  # type: ignore[arg-type]
            return cand, True  # type: ignore[return-value]
        if l >= 1.0:
            break
    return (255, 255, 255), True


def saturation(rgb: tuple[int, int, int]) -> float:
    """HLS saturation. Only meaningful in mid-lightness; prefer :func:`chroma`."""
    return colorsys.rgb_to_hls(*(c / 255.0 for c in rgb))[2]


def chroma(rgb: tuple[int, int, int]) -> float:
    """CIE-Lab chroma — how colourful this is, independent of how light it is."""
    _, a, b = _rgb_to_lab(rgb)
    return (a * a + b * b) ** 0.5


def derive_partner(primary: tuple[int, int, int]) -> tuple[int, int, int]:
    """A companion colour for a sleeve with only one usable colour in it.

    ``primary`` must already clear the contrast floor. The partner moves away
    from whichever end of the lightness range the primary sits nearest (a white
    sleeve gets a darker partner, a dark one a lighter partner) with a small
    hue nudge so the gradient has some life. The step widens until the pair is
    genuinely distinguishable *after* the partner has itself been pushed back
    onto the contrast floor — lifting a dark partner can otherwise slide it
    straight back into the primary, which is how a gradient silently goes flat.
    """
    h, l, s = colorsys.rgb_to_hls(*(c / 255.0 for c in primary))
    away = -1.0 if l > 0.5 else 1.0
    partner_h = (h + DERIVED_HUE_SHIFT) % 1.0
    # A grey primary has no hue worth rotating; give the partner a little
    # saturation so the gradient is not two identical greys.
    partner_s = s if s > 0.08 else min(1.0, s + 0.10)

    for step in DERIVED_STEPS:
        for direction in (away, -away):
            partner_l = min(1.0, max(0.0, l + direction * step))
            cand = tuple(
                int(round(c * 255))
                for c in colorsys.hls_to_rgb(partner_h, partner_l, partner_s)
            )
            cand, _ = ensure_contrast(cand)  # type: ignore[arg-type]
            if delta_e(primary, cand) >= MIN_DELTA_E:
                return cand
    # Unreachable in practice; a guaranteed-far neutral rather than a flat bar.
    return (255, 255, 255) if relative_luminance(primary) < 0.35 else (97, 97, 97)


def is_color(rgb: tuple[int, int, int]) -> bool:
    """Is this a colour, as opposed to a shade of grey or a noisy near-black?

    Two gates, and both are needed:

    * **Lightness.** Hue is not trustworthy at the ends of the range. The
      near-black ``#060a0b`` is three channels five levels apart; HLS calls it
      0.29 saturated — more than an olive green — and picking it as "the
      album's colour" is how a black sleeve gets a teal progress bar.
    * **Some chroma before lifting.** A genuinely dark colour still measures a
      little colourful raw (*Come to My Garden*'s olive, 7.1); black with
      rounding noise on it measures none (``#101918``, 2.4). Without this,
      *All Eyez on Me* — a sleeve that is 70% near-black — leads with a teal
      invented by the lift.
    * **Enough chroma after lifting.** Lab chroma is compressed at low
      lightness, so a real dark colour reads as drab until it is lifted onto
      the contrast floor, and the lifted colour is what the app renders.
      Judging only the raw cluster throws away colours worth keeping.
    """
    lightness = colorsys.rgb_to_hls(*(c / 255.0 for c in rgb))[1]
    if not CHROMA_LIGHTNESS_MIN <= lightness <= CHROMA_LIGHTNESS_MAX:
        return False
    if chroma(rgb) < CHROMA_TINT:
        return False
    lifted, _ = ensure_contrast(rgb)
    return chroma(lifted) >= CHROMA_MIN


def colored_clusters(clusters: list[tuple[tuple[int, int, int], int]],
                     min_weight: float, by: str = "weight"
                     ) -> list[tuple[int, int, int]]:
    """The clusters that are genuinely colours, best first.

    A cluster qualifies on two counts: it reads as a colour (:func:`is_color`)
    and it covers enough of the sleeve to be part of what the record looks
    like.

    The two slots want different orderings. The **primary** should be the
    colour most *present* on the sleeve, so it goes by weight. The **partner**
    exists to make the gradient read, so it goes by colourfulness: on *Whole
    Lotta Red* the qualifying clusters are a muted maroon at 2.1% and the
    actual red at 2.0%, and sorting those by weight loses the red by a
    rounding error.
    """
    total = sum(n for _, n in clusters) or 1
    viable = [(rgb, n) for rgb, n in clusters
              if n / total >= min_weight and is_color(rgb)]
    if by == "chroma":
        viable.sort(key=lambda t: -chroma(ensure_contrast(t[0])[0]))
    else:
        viable.sort(key=lambda t: (-t[1], -chroma(ensure_contrast(t[0])[0])))
    return [rgb for rgb, _ in viable]


def _first_distinct(primary: tuple[int, int, int],
                    candidates: list[tuple[int, int, int]]
                    ) -> tuple[int, int, int] | None:
    """First candidate still distinct from ``primary`` *after* contrast lifting.

    Checking the raw colours instead lets a pair converge while being lifted
    and ship as a flat bar.
    """
    for rgb in candidates:
        cand, _ = ensure_contrast(rgb)
        if delta_e(primary, cand) >= MIN_DELTA_E:
            return cand
    return None


def make_pair(clusters: list[tuple[tuple[int, int, int], int]]) -> ColorPair:
    """Turn ranked ``(rgb, weight)`` clusters into a guaranteed-usable pair.

    ``clusters`` must be sorted most-common first. Safe with 0, 1 or many.

    The ordering of the rules below is the whole design. **Both ends are drawn
    from the sleeve's real colours before greyscale is considered at all** —
    picking only the primary from them just moves white into the other slot,
    and gold-to-white renders as a beige smear exactly like white-to-gold does.
    Only a sleeve with no real colour on it gets a greyscale pair, which for
    the White Album or *Madvillainy* is the honest answer.
    """
    if not clusters:
        return fallback_pair()

    leads = colored_clusters(clusters, CHROMATIC_LEAD_WEIGHT)
    partners = colored_clusters(clusters, CHROMATIC_WEIGHT, by="chroma")

    # 1. The sleeve has a colour big enough to lead: both ends come from its
    #    colours, and if there is only one, the partner is a tint of it rather
    #    than the white border it happens to sit on.
    if leads:
        primary, adjusted = ensure_contrast(leads[0])
        secondary = _first_distinct(primary, [c for c in partners if c != leads[0]])
        if secondary is None:
            return ColorPair(rgb_to_hex(primary), rgb_to_hex(derive_partner(primary)),
                             SATURATED_DERIVED, adjusted)
        return ColorPair(rgb_to_hex(primary), rgb_to_hex(secondary), SATURATED, adjusted)

    primary, adjusted = ensure_contrast(clusters[0][0])

    # 2. The only colour on the sleeve is too small to lead (a logo, a title
    #    bar). It still gets to colour the gradient from the other end.
    if partners:
        secondary = _first_distinct(primary, partners)
        if secondary is not None:
            return ColorPair(rgb_to_hex(primary), rgb_to_hex(secondary),
                             SATURATED_PARTNER, adjusted)

    # 3. A muted sleeve — a washed-out photograph, no real colour but a tint.
    #    Carry the tint through both ends instead of pairing it with neutral
    #    grey, which is what makes a muted sleeve read as a system control.
    if chroma(primary) >= CHROMA_TINT:
        return ColorPair(rgb_to_hex(primary), rgb_to_hex(derive_partner(primary)),
                         DERIVED, adjusted)

    # 4. Genuinely greyscale. Say so.
    secondary = _first_distinct(primary, [rgb for rgb, _ in clusters[1:]])
    if secondary is None:
        return ColorPair(rgb_to_hex(primary), rgb_to_hex(derive_partner(primary)),
                         DERIVED, adjusted)
    return ColorPair(rgb_to_hex(primary), rgb_to_hex(secondary), DOMINANT, adjusted)


#: Neutral slate used when there is no usable image at all. Built through the
#: same rules as everything else, so it is guaranteed readable and non-flat.
FALLBACK_RGB = (138, 138, 145)


def fallback_pair() -> ColorPair:
    pair = make_pair([(FALLBACK_RGB, 1)])
    return ColorPair(pair.primary, pair.secondary, NEUTRAL_FALLBACK, True)


# --------------------------------------------------------------------------
# Image -> clusters
# --------------------------------------------------------------------------

def _open(data: bytes):
    from PIL import Image  # imported lazily so the rest of the module is dependency-free

    img = Image.open(io.BytesIO(data))
    img = img.convert("RGB")
    img.thumbnail((SAMPLE_SIZE, SAMPLE_SIZE))
    return img


def cluster_image(data: bytes, colors: int = QUANTIZE_COLORS
                  ) -> list[tuple[tuple[int, int, int], int]]:
    """Adaptive-palette quantize an image into ranked ``(rgb, pixel_count)``.

    Near-identical palette entries are merged (ΔE < 6) so a sleeve that is one
    colour with JPEG noise reports as one cluster rather than sixteen.
    """
    from PIL import Image

    img = _open(data)
    pal = img.quantize(colors=colors, method=Image.Quantize.MEDIANCUT)
    palette = pal.getpalette() or []
    counts = sorted(pal.getcolors() or [], key=lambda c: -c[0])

    merged: list[list] = []
    for count, index in counts:
        rgb = tuple(palette[index * 3: index * 3 + 3])
        if len(rgb) != 3:
            continue
        for entry in merged:
            if delta_e(entry[0], rgb) < 6.0:  # type: ignore[arg-type]
                entry[1] += count
                break
        else:
            merged.append([rgb, count])
    merged.sort(key=lambda e: -e[1])
    return [(tuple(rgb), int(n)) for rgb, n in merged]  # type: ignore[misc]


def extract_colors(data: bytes | None) -> ColorPair:
    """Public entry point: image bytes -> a gradient-safe colour pair."""
    if not data:
        return fallback_pair()
    try:
        clusters = cluster_image(data)
    except Exception:  # unreadable / truncated image — still return something
        return fallback_pair()
    return make_pair(clusters)
