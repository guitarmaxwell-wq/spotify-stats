"""Placeholder sticker, badge and poster art for Milk rewards.

Everything here is ORIGINAL placeholder art: type, shapes and colour only. No
band logo or album artwork is traced, embedded or fetched. An album's extracted
colour *palette* (from data/collection.json) is used, and a palette is not
artwork.

The output is deterministic: the same inputs always give byte-identical SVGs,
so re-running is safe and diffs are meaningful. What gets drawn is listed in
manifest.json; each entry's `path` is its path inside the `reward-art` storage
bucket, and that is what `rewards.art_url` points at. Replacing a placeholder
with real art later means uploading a new file to the same path. No code or
row changes are needed.

Usage (from the repo root):

    venv\\Scripts\\python.exe tools\\stickers\\generate.py              # manifest -> out/reward-art/
    venv\\Scripts\\python.exe tools\\stickers\\generate.py --samples 12 # + shelf artists -> out/samples/
    venv\\Scripts\\python.exe tools\\stickers\\generate.py --png        # + PNG contact sheet via headless Chrome

See README.md for the upload step.
"""
from __future__ import annotations

import argparse
import colorsys
import hashlib
import itertools
import json
import math
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from xml.sax.saxutils import escape

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT))

from pipeline.normalize import artist_key, slugify  # noqa: E402  (shared with the pipeline)

COLLECTION = ROOT / "data" / "collection.json"
MANIFEST = HERE / "manifest.json"
OUT = HERE / "out"
BUCKET_DIR = OUT / "reward-art"

FONT = "'Arial Black','Archivo Black','Helvetica Neue',Helvetica,Arial,sans-serif"
INK = "#15131a"
PAPER = "#ffffff"

# Used when an artist has no albums on the shelf. Each is (body, accent).
FALLBACK = [
    ("#e4572e", "#ffc914"),
    ("#2e86ab", "#f6ae2d"),
    ("#6a4c93", "#ff9f1c"),
    ("#1b998b", "#fffd82"),
    ("#ef476f", "#06d6a0"),
    ("#264653", "#e9c46a"),
    ("#ff595e", "#1982c4"),
    ("#3d348b", "#f7b801"),
    ("#0b6e4f", "#fa9f42"),
    ("#d62246", "#4b1d3f"),
    ("#f18701", "#1d3557"),
    ("#8338ec", "#3a86ff"),
]

CAPTIONS = ["HEAVY ROTATION", "ON REPEAT", "CERTIFIED LISTENER", "SIDE A", "DEEP CUTS", "NO SKIPS"]


# ----------------------------------------------------------------- helpers --

def h(*parts: object) -> int:
    """Stable hash (Python's hash() is salted per process)."""
    raw = "\x1f".join(str(p) for p in parts).encode("utf-8")
    return int.from_bytes(hashlib.sha256(raw).digest()[:8], "big")


def f(x: float) -> str:
    """Stable, compact number formatting."""
    s = f"{x:.2f}".rstrip("0").rstrip(".")
    return "0" if s == "-0" else s


def rgb(hexs: str) -> tuple[float, float, float]:
    s = hexs.lstrip("#")
    return tuple(int(s[i:i + 2], 16) / 255 for i in (0, 2, 4))  # type: ignore[return-value]


def hexc(c: tuple[float, float, float]) -> str:
    return "#" + "".join(f"{max(0, min(255, round(v * 255))):02x}" for v in c)


def lum(hexs: str) -> float:
    def lin(v: float) -> float:
        return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = (lin(v) for v in rgb(hexs))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a: str, b: str) -> float:
    la, lb = sorted((lum(a), lum(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def mix(a: str, b: str, t: float) -> str:
    ca, cb = rgb(a), rgb(b)
    return hexc(tuple(x + (y - x) * t for x, y in zip(ca, cb)))  # type: ignore[arg-type]


def shade(c: str, amount: float) -> str:
    """amount < 0 darkens toward black, > 0 lightens toward white."""
    return mix(c, "#000000" if amount < 0 else "#ffffff", abs(amount))


def text_on(bg: str, *prefer: str) -> str:
    """The first preferred colour that reads on `bg`, else ink or paper."""
    for c in prefer:
        if c and contrast(c, bg) >= 4.5:
            return c
    return INK if contrast(INK, bg) >= contrast(PAPER, bg) else PAPER


def vivid(c: str) -> str:
    """Nudge a muddy album colour toward something that reads as a sticker."""
    hh, ll, ss = colorsys.rgb_to_hls(*rgb(c))
    ss = min(1.0, ss * 1.25 + 0.05)
    ll = min(0.78, max(0.22, ll))
    return hexc(colorsys.hls_to_rgb(hh, ll, ss))


# Advance widths in em for a heavy grotesque, for fitting text. Only an
# estimate: every text element also gets textLength, so the layout holds even
# when the renderer substitutes a different font.
def char_w(ch: str) -> float:
    if ch == " ":
        return 0.3
    if ch in "IJ1!|.,:;'`":
        return 0.4
    if ch in "MW@":
        return 0.98
    if ch.isdigit():
        return 0.68
    if ch in "-/()&$+":
        return 0.5
    return 0.76


def text_w(s: str, size: float) -> float:
    return sum(char_w(c) for c in s) * size


def split_lines(words: list[str], n: int) -> list[list[str]]:
    """Every way to break `words` into n non-empty lines."""
    if n == 1:
        return [[" ".join(words)]]
    out = []
    for cuts in itertools.combinations(range(1, len(words)), n - 1):
        bounds = (0, *cuts, len(words))
        out.append([" ".join(words[a:b]) for a, b in zip(bounds, bounds[1:])])
    return out


def fit(text: str, box_w: float, box_h: float, max_lines: int = 3,
        max_size: float = 120, lh: float = 0.98) -> tuple[list[str], float]:
    """Choose line breaks and a font size that fill (box_w x box_h)."""
    words = text.split() or [text]
    best: tuple[float, list[str]] = (0, [text])
    for n in range(1, min(max_lines, len(words)) + 1):
        for lines in split_lines(words, n):
            widest = max(text_w(line, 1) for line in lines)
            size = min(max_size, box_w / widest, box_h / (0.74 + (n - 1) * lh))
            # Prefer fewer lines unless more lines buy a clearly bigger size.
            score = size * (1 - 0.06 * (n - 1))
            if score > best[0]:
                best = (score, lines)
    lines = best[1]
    n = len(lines)
    widest = max(text_w(line, 1) for line in lines)
    size = min(max_size, box_w / widest, box_h / (0.74 + (n - 1) * lh))
    return lines, size


def text_block(text: str, cx: float, cy: float, box_w: float, box_h: float, fill: str,
               max_lines: int = 3, max_size: float = 120, stroke: str | None = None,
               stroke_w: float = 0, lh: float = 0.98, spacing: float = 0,
               offset: tuple[float, float, str] | None = None) -> str:
    """Centred, fitted, multi-line text. `offset` adds a retro drop layer."""
    lines, size = fit(text, box_w, box_h, max_lines, max_size, lh)
    cap = 0.72 * size
    total = cap + (len(lines) - 1) * lh * size
    y0 = cy - total / 2 + cap
    out = []
    layers = []
    if offset:
        layers.append((offset[0], offset[1], offset[2], None))
    layers.append((0, 0, fill, stroke))
    for dx, dy, col, stk in layers:
        for i, line in enumerate(lines):
            w = min(box_w, text_w(line, size))
            attrs = (f'x="{f(cx + dx)}" y="{f(y0 + i * lh * size + dy)}" font-size="{f(size)}" '
                     f'fill="{col}" textLength="{f(w)}" lengthAdjust="spacingAndGlyphs"')
            if stk:
                attrs += (f' stroke="{stk}" stroke-width="{f(stroke_w)}" paint-order="stroke" '
                          f'stroke-linejoin="round"')
            out.append(f'<text {attrs}>{escape(line)}</text>')
    return "\n".join(out)


def small_text(text: str, cx: float, y: float, size: float, fill: str, max_w: float,
               spacing: float = 0.12) -> str:
    w = min(max_w, text_w(text, size) + spacing * size * max(0, len(text) - 1))
    return (f'<text x="{f(cx)}" y="{f(y)}" font-size="{f(size)}" fill="{fill}" '
            f'textLength="{f(w)}" lengthAdjust="spacingAndGlyphs">{escape(text)}</text>')


# ------------------------------------------------------------------ shapes --
# Each returns (path d, max of x+y over the outline) -- the latter places the
# peel fold for the bottom-right corner.

def rounded_rect(x: float, y: float, w: float, hgt: float, r: float) -> tuple[str, float]:
    d = (f"M{f(x + r)} {f(y)}H{f(x + w - r)}A{f(r)} {f(r)} 0 0 1 {f(x + w)} {f(y + r)}"
         f"V{f(y + hgt - r)}A{f(r)} {f(r)} 0 0 1 {f(x + w - r)} {f(y + hgt)}"
         f"H{f(x + r)}A{f(r)} {f(r)} 0 0 1 {f(x)} {f(y + hgt - r)}"
         f"V{f(y + r)}A{f(r)} {f(r)} 0 0 1 {f(x + r)} {f(y)}Z")
    return d, x + w + y + hgt - r * (2 - math.sqrt(2))


def circle(cx: float, cy: float, r: float) -> tuple[str, float]:
    d = (f"M{f(cx - r)} {f(cy)}A{f(r)} {f(r)} 0 1 0 {f(cx + r)} {f(cy)}"
         f"A{f(r)} {f(r)} 0 1 0 {f(cx - r)} {f(cy)}Z")
    return d, cx + cy + r * math.sqrt(2)


def polygon(pts: list[tuple[float, float]]) -> tuple[str, float]:
    d = "M" + "L".join(f"{f(x)} {f(y)}" for x, y in pts) + "Z"
    return d, max(x + y for x, y in pts)


def star(cx: float, cy: float, r_out: float, r_in: float, n: int, rot: float = 0) -> tuple[str, float]:
    pts = []
    for i in range(n * 2):
        r = r_out if i % 2 == 0 else r_in
        a = rot + math.pi * i / n - math.pi / 2
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return polygon(pts)


def ribbon(cx: float, cy: float, w: float, hgt: float, notch: float) -> tuple[str, float]:
    x0, x1, y0, y1 = cx - w / 2, cx + w / 2, cy - hgt / 2, cy + hgt / 2
    return polygon([(x0, y0), (x1, y0), (x1 - notch, cy), (x1, y1), (x0, y1), (x0 + notch, cy)])


def slot_hole(cx: float, y: float, w: float, hgt: float) -> str:
    """A lanyard slot, drawn counter-clockwise so evenodd/nonzero both cut it."""
    r = hgt / 2
    return (f"M{f(cx - w / 2 + r)} {f(y)}A{f(r)} {f(r)} 0 0 0 {f(cx - w / 2 + r)} {f(y + hgt)}"
            f"H{f(cx + w / 2 - r)}A{f(r)} {f(r)} 0 0 0 {f(cx + w / 2 - r)} {f(y)}Z")


# ----------------------------------------------------------------- sticker --

@dataclass
class Palette:
    body: str
    accent: str
    source: str  # "shelf" or "fallback"


def sticker(uid: str, shape: tuple[str, float], inner: str, *, size: int = 512,
            border: float = 13, seed: int = 0, peel: bool | None = None,
            max_tilt: float = 7, holes: str = "") -> str:
    """Wrap a shape + artwork as a die-cut sticker: white border, soft drop
    shadow, a slight tilt, and (sometimes) a peeling corner."""
    d, extent = shape
    tilt = ((seed % 1000) / 1000 * 2 - 1) * max_tilt
    if peel is None:
        peel = (seed >> 12) % 3 != 0
    depth = 36 + (seed >> 20) % 20
    c = extent + border - depth  # fold line: x + y = c
    big = 4000
    keep = f"M{-big} {-big}L{c + big} {-big}L{-big} {c + big}Z"
    cut = f"M{c + big} {-big}L{big} {big}L{-big} {c + big}Z"
    reflect = f"matrix(0 -1 -1 0 {f(c)} {f(c)})"  # reflection across x + y = c
    cx = size / 2

    defs = [
        f'<filter id="{uid}-sh" x="-25%" y="-25%" width="150%" height="150%">'
        f'<feGaussianBlur stdDeviation="7"/></filter>',
        f'<linearGradient id="{uid}-gloss" x1="0" y1="0" x2="0.7" y2="1">'
        f'<stop offset="0" stop-color="#fff" stop-opacity=".32"/>'
        f'<stop offset=".45" stop-color="#fff" stop-opacity="0"/></linearGradient>',
    ]
    if peel:
        defs += [
            f'<clipPath id="{uid}-keep"><path d="{keep}"/></clipPath>',
            f'<clipPath id="{uid}-cut"><path d="{cut}"/></clipPath>',
            # The flap is the sticker's back: pale paper, darker toward the fold.
            f'<linearGradient id="{uid}-flap" gradientUnits="userSpaceOnUse" '
            f'x1="{f(c / 2)}" y1="{f(c / 2)}" x2="{f(c / 2 - 60)}" y2="{f(c / 2 - 60)}">'
            f'<stop offset="0" stop-color="#d9d6d0"/><stop offset="1" stop-color="#f7f5f0"/>'
            f'</linearGradient>',
        ]

    outline = f'd="{d}"'
    if holes:  # punched through the paper, border and all
        defs.append(f'<mask id="{uid}-holes" maskUnits="userSpaceOnUse" x="0" y="0" width="{size}" '
                    f'height="{size}"><rect width="{size}" height="{size}" fill="#fff"/>'
                    f'<path d="{holes}" fill="#000"/></mask>')
    body = [
        f'<path {outline} fill="{PAPER}" stroke="{PAPER}" stroke-width="{f(border * 2)}" '
        f'stroke-linejoin="round"/>',
        inner,
        f'<path {outline} fill="url(#{uid}-gloss)"/>',
    ]
    shadow_clip = f' clip-path="url(#{uid}-keep)"' if peel else ""
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
        f'viewBox="0 0 {size} {size}" width="{size}" height="{size}">',
        f'<defs>{"".join(defs)}</defs>',
        f'<g transform="rotate({f(tilt)} {f(cx)} {f(cx)})" font-family="{FONT}" font-weight="900" '
        f'text-anchor="middle">',
        # Shadow: an offset, blurred silhouette. Without filter support it
        # degrades to a flat 22% silhouette, which still reads as a shadow.
        f'<g{shadow_clip}><path {outline} transform="translate(5 9)" fill="#000" fill-opacity=".22" '
        f'stroke="#000" stroke-opacity=".22" stroke-width="{f(border * 2)}" stroke-linejoin="round" '
        f'filter="url(#{uid}-sh)"/></g>',
        f'<g clip-path="url(#{uid}-keep)">' if peel else "<g>",
        f'<g mask="url(#{uid}-holes)">' if holes else "<g>",
        *body,
        "</g>",
        "</g>",
    ]
    if peel:
        parts += [
            # The lifted flap casts a small shadow onto the sticker.
            f'<g transform="{reflect}"><g clip-path="url(#{uid}-cut)">'
            f'<path {outline} transform="translate(-4 -4)" fill="#000" fill-opacity=".18" '
            f'stroke="#000" stroke-opacity=".18" stroke-width="{f(border * 2)}" stroke-linejoin="round" '
            f'filter="url(#{uid}-sh)"/>'
            f'<path {outline} fill="url(#{uid}-flap)" stroke="url(#{uid}-flap)" '
            f'stroke-width="{f(border * 2)}" stroke-linejoin="round"/></g></g>',
        ]
    parts += ["</g>", "</svg>"]
    return "\n".join(p for p in parts if p) + "\n"


# ------------------------------------------------------------ artist art --

def artist_sticker(name: str, pal: Palette, *, uid: str = "s", layout: str | None = None,
                   placeholder: bool = False) -> str:
    seed = h("artist", name)
    layouts = ["badge", "banner", "circle", "burst"]
    layout = layout or layouts[seed % len(layouts)]
    caption = CAPTIONS[(seed >> 8) % len(CAPTIONS)]
    body, accent = pal.body, pal.accent
    ink = text_on(body, accent)
    label = name.upper()

    def name_block(cx, cy, w, hh, fill, **kw):
        if placeholder:
            return slot(cx, cy, w, hh * 0.62, fill)
        return text_block(label, cx, cy, w, hh, fill, **kw)

    if layout == "badge":
        shape = rounded_rect(86, 116, 340, 280, 38)
        band = accent if contrast(accent, body) > 1.4 else shade(body, -0.35)
        band_ink = text_on(band, body)
        inner = "\n".join([
            f'<path d="{shape[0]}" fill="{body}"/>',
            f'<path d="{rounded_rect(86, 116, 340, 66, 38)[0]}" fill="{band}"/>',
            f'<rect x="86" y="150" width="340" height="32" fill="{band}"/>',
            small_text(f"★ {caption} ★", 256, 160, 22, band_ink, 290),
            name_block(256, 280, 290, 150, ink, max_lines=3),
            f'<rect x="126" y="360" width="260" height="6" rx="3" fill="{band}"/>',
        ])
    elif layout == "banner":
        shape = ribbon(256, 256, 460, 200, 44)
        stripe = accent if contrast(accent, body) > 1.4 else shade(body, 0.4)
        inner = "\n".join([
            f'<path d="{shape[0]}" fill="{body}"/>',
            f'<rect x="26" y="176" width="460" height="9" fill="{stripe}"/>',
            f'<rect x="26" y="327" width="460" height="9" fill="{stripe}"/>',
            small_text("★", 86, 268, 30, stripe, 40),
            small_text("★", 426, 268, 30, stripe, 40),
            name_block(256, 256, 290, 120, ink, max_lines=2),
        ])
    elif layout == "circle":
        shape = circle(256, 256, 196)
        ring = accent if contrast(accent, body) > 1.4 else shade(body, -0.35)
        ring_ink = text_on(ring, body)
        # Repeat the caption as many times as fills the ring at its natural
        # width, so textLength only nudges the spacing rather than spreading it.
        unit = f"{caption} • "
        circ = 2 * math.pi * 172
        reps = max(2, round(circ / (text_w(unit, 25) + 3 * len(unit))))
        inner = "\n".join([
            f'<path d="{shape[0]}" fill="{ring}"/>',
            f'<circle cx="256" cy="256" r="150" fill="{body}"/>',
            f'<path id="{uid}-ring" d="M256 84A172 172 0 1 1 255.9 84" fill="none"/>',
            f'<text font-size="25" fill="{ring_ink}" text-anchor="start">'
            f'<textPath href="#{uid}-ring" xlink:href="#{uid}-ring" startOffset="0" '
            f'textLength="{f(circ - 6)}" lengthAdjust="spacing">'
            f'{escape(unit * reps)}</textPath></text>',
            name_block(256, 256, 230, 170, ink, max_lines=3),
        ])
    else:  # burst
        n = 18 + seed % 6
        shape = star(256, 256, 206, 178, n, rot=(seed >> 4) % 10 / 100)
        disc = accent if contrast(accent, body) > 1.4 else shade(body, 0.3)
        disc_ink = text_on(disc, body)
        inner = "\n".join([
            f'<path d="{shape[0]}" fill="{body}"/>',
            f'<circle cx="256" cy="256" r="150" fill="{disc}"/>',
            f'<circle cx="256" cy="256" r="138" fill="none" stroke="{body}" stroke-width="4" '
            f'stroke-dasharray="2 10" stroke-linecap="round"/>',
            name_block(256, 256, 220, 160, disc_ink, max_lines=3),
        ])
    # Only smooth outlines peel: a starburst's points make a ragged flap.
    return sticker(uid, shape, inner, seed=seed, peel=False if layout == "burst" else None)


def slot(cx: float, cy: float, w: float, hh: float, color: str) -> str:
    """The empty name slot on a template: a dashed box saying what goes here."""
    hh = min(hh, 90)
    return (f'<rect x="{f(cx - w / 2)}" y="{f(cy - hh / 2)}" width="{f(w)}" height="{f(hh)}" rx="14" '
            f'fill="none" stroke="{color}" stroke-width="4" stroke-dasharray="14 10" opacity=".85"/>'
            + small_text("ARTIST NAME", cx, cy + 10, 28, color, w - 40))


def number_sticker(name: str, number: str, pal: Palette, *, uid: str = "n") -> str:
    """The number is the hero. The artist name sits on a ribbon across it."""
    seed = h("number", name, number)
    body, accent = pal.body, pal.accent
    hero_ink = text_on(body, accent, PAPER)
    drop = shade(body, -0.45) if lum(hero_ink) > lum(body) else shade(body, 0.45)
    if seed % 2:
        shape = star(256, 256, 214, 188, 20 + seed % 5)
    else:
        shape = circle(256, 256, 204)
    rib = accent if contrast(accent, body) > 1.6 else INK
    rib_ink = text_on(rib, body, PAPER)
    rib_shape = ribbon(256, 352, 360, 64, 20)[0]
    inner = "\n".join([
        f'<path d="{shape[0]}" fill="{body}"/>',
        f'<circle cx="256" cy="256" r="178" fill="none" stroke="{hero_ink}" stroke-opacity=".35" '
        f'stroke-width="3"/>',
        small_text("PLAYS", 256, 136, 26, hero_ink, 120, spacing=0.3),
        text_block(number, 256, 232, 300, 150, hero_ink, max_lines=1, max_size=200,
                   offset=(6, 7, drop)),
        f'<path d="{rib_shape}" transform="translate(4 5)" fill="#000" fill-opacity=".2"/>',
        f'<path d="{rib_shape}" fill="{rib}"/>',
        text_block(name.upper(), 256, 352, 250, 34, rib_ink, max_lines=1, max_size=34),
    ])
    return sticker(uid, shape, inner, seed=seed, max_tilt=5, peel=False if seed % 2 else None)


def community_pass(name: str | None, pal: Palette, *, uid: str = "c") -> str:
    """A backstage laminate: reads as ACCESS, not decoration. Portrait card,
    lanyard slot, ALL ACCESS header, name, barcode, foil square."""
    seed = h("community", name or "")
    body, accent = pal.body, pal.accent
    x, y, w, hh = 136, 52, 240, 408
    shape = rounded_rect(x, y, w, hh, 22)
    hole = slot_hole(256, y + 22, 70, 18)
    head = accent if contrast(accent, body) > 1.4 else INK
    head_ink = text_on(head, body)
    ink = text_on(body, accent)
    # A decorative barcode, deterministic from the name. Not a real code.
    bars, bx = [], x + 30
    bseed = seed
    while bx < x + w - 32:
        bw = 2 + bseed % 4
        bars.append(f'<rect x="{f(bx)}" y="402" width="{bw}" height="36" fill="{ink}"/>')
        bx += bw + 2 + (bseed >> 3) % 4
        bseed = (bseed * 6364136223846793005 + 1442695040888963407) & (2**64 - 1)
    name_part = (text_block(name.upper(), 256, 268, 200, 120, ink, max_lines=3)
                 if name else slot(256, 268, 200, 80, ink))
    inner = "\n".join([
        f'<defs><linearGradient id="{uid}-foil" x1="0" y1="0" x2="1" y2="1">'
        f'<stop offset="0" stop-color="#9be7ff"/><stop offset=".33" stop-color="#f7a8ff"/>'
        f'<stop offset=".66" stop-color="#fff59d"/><stop offset="1" stop-color="#8affc1"/>'
        f'</linearGradient></defs>',
        f'<path d="{shape[0]}" fill="{body}"/>',
        f'<path d="M{x} 116H{x + w}V190H{x}Z" fill="{head}"/>',
        small_text("ALL ACCESS", 256, 166, 40, head_ink, 200),
        small_text("MEMBER · COMMUNITY PASS", 256, 214, 13, ink, 190, spacing=0.2),
        name_part,
        f'<rect x="{x + 30}" y="340" width="44" height="44" rx="6" fill="url(#{uid}-foil)"/>',
        f'<text x="{x + 88}" y="358" font-size="12" fill="{ink}" text-anchor="start">ADMIT ONE</text>',
        f'<text x="{x + 88}" y="378" font-size="12" fill="{ink}" text-anchor="start" '
        f'opacity=".75">FAN ONLY</text>',
        *bars,
    ])
    # A laminate hangs straight, so less tilt, and it never peels.
    return sticker(uid, shape, inner, seed=seed, peel=False, max_tilt=4, holes=hole)


def poster(title: str | None, artist: str | None, pal: Palette, *, uid: str = "p",
           year: int | None = None) -> str:
    """Portrait print, 600x900, taped to the wall. Swiss-ish geometry from the
    album palette; nothing from the cover itself."""
    seed = h("poster", title or "", artist or "")
    W, H = 600, 900
    body, accent = pal.body, pal.accent
    paper = "#f4efe6"
    ink = text_on(body, accent)
    x0, y0, pw, ph = 60, 60, 480, 780  # the print, inside the canvas
    ix, iy, iw, ih = x0 + 26, y0 + 26, pw - 52, 470  # art field
    variant = seed % 4
    g = []
    cx, cy = ix + iw / 2, iy + ih / 2
    if variant == 0:  # sun over stripes
        g.append(f'<circle cx="{f(cx)}" cy="{f(iy + ih * 0.42)}" r="{f(iw * 0.3)}" fill="{accent}"/>')
        for i in range(7):
            yy = iy + ih * 0.58 + i * 26
            g.append(f'<rect x="{ix}" y="{f(yy)}" width="{iw}" height="{f(9 + i * 1.6)}" fill="{body}"/>')
    elif variant == 1:  # record grooves, off-centre
        ox = ix + iw * (0.35 + (seed >> 6) % 30 / 100)
        for i, r in enumerate(range(200, 10, -22)):
            g.append(f'<circle cx="{f(ox)}" cy="{f(cy)}" r="{r}" fill="{accent if i % 2 else shade(accent, -0.18)}"/>')
        g.append(f'<circle cx="{f(ox)}" cy="{f(cy)}" r="30" fill="{paper}"/>')
    elif variant == 2:  # dot grid, one dot picked out
        pick = seed % 20
        for i in range(5):
            for j in range(4):
                c = accent if i * 4 + j == pick else shade(accent, -0.25)
                g.append(f'<circle cx="{f(ix + 54 + j * 108)}" cy="{f(iy + 50 + i * 92)}" r="38" fill="{c}"/>')
    else:  # diagonal bands
        for i in range(-4, 9):
            xx = ix + i * 62
            col = accent if i % 3 else shade(accent, -0.3)
            g.append(f'<path d="M{f(xx)} {iy + ih}L{f(xx + 40)} {iy + ih}L{f(xx + 40 + ih * 0.6)} {iy}'
                     f'L{f(xx + ih * 0.6)} {iy}Z" fill="{col}"/>')

    t_lines = (text_block(title.upper(), W / 2, 694, 400, 120, INK, max_lines=3, max_size=64)
               if title else slot(W / 2, 694, 400, 90, INK).replace("ARTIST NAME", "ALBUM TITLE"))
    who = (artist or "ARTIST").upper()
    tape = "#f5e9b8"
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}">',
        f'<defs><filter id="{uid}-sh" x="-10%" y="-10%" width="120%" height="120%">'
        f'<feGaussianBlur stdDeviation="9"/></filter>'
        f'<clipPath id="{uid}-art"><rect x="{ix}" y="{iy}" width="{iw}" height="{ih}"/></clipPath></defs>',
        f'<g transform="rotate({f(((seed >> 16) % 100 / 100 * 2 - 1) * 1.6)} 300 450)" '
        f'font-family="{FONT}" font-weight="900" text-anchor="middle">',
        f'<rect x="{x0 + 6}" y="{y0 + 12}" width="{pw}" height="{ph}" fill="#000" fill-opacity=".25" '
        f'filter="url(#{uid}-sh)"/>',
        f'<rect x="{x0}" y="{y0}" width="{pw}" height="{ph}" fill="{paper}"/>',
        f'<rect x="{ix}" y="{iy}" width="{iw}" height="{ih}" fill="{shade(body, 0.15) if variant == 0 else body}"/>',
        f'<g clip-path="url(#{uid}-art)">{"".join(g)}</g>',
        t_lines,
        f'<rect x="{ix}" y="{iy + ih + 26}" width="{iw}" height="3" fill="{INK}"/>',
        small_text(who, W / 2, 790, 22, INK, 380, spacing=0.16),
        f'<text x="{ix}" y="820" font-size="12" fill="{INK}" text-anchor="start" opacity=".6">'
        f'{escape(str(year) if year else "MILK")}</text>',
        f'<text x="{ix + iw}" y="820" font-size="12" fill="{INK}" text-anchor="end" opacity=".6">'
        f'ON HEAVY ROTATION</text>',
        # Two strips of tape holding it up.
        f'<rect x="{x0 - 30}" y="{y0 - 14}" width="110" height="34" fill="{tape}" fill-opacity=".82" '
        f'transform="rotate(-32 {x0 + 25} {y0 + 3})"/>',
        f'<rect x="{x0 + pw - 80}" y="{y0 - 14}" width="110" height="34" fill="{tape}" fill-opacity=".82" '
        f'transform="rotate(30 {x0 + pw + 25} {y0 + 3})"/>',
        "</g>",
        "</svg>",
    ]
    return "\n".join(parts) + "\n"


# ---------------------------------------------------------------- palette --

class Shelf:
    """Palettes from data/collection.json, keyed by the pipeline's artist_key."""

    def __init__(self, path: Path = COLLECTION):
        self.by_artist: dict[str, list[dict]] = {}
        self.by_album: dict[str, dict] = {}
        if not path.exists():
            return
        data = json.loads(path.read_text(encoding="utf-8"))
        for a in data.get("albums", []):
            if not (a.get("colors") or {}).get("primary"):
                continue
            self.by_artist.setdefault(artist_key(a["artist"]), []).append(a)
            self.by_album[a["id"]] = a
        for albums in self.by_artist.values():
            albums.sort(key=lambda a: (-(a.get("play_count") or 0), a["id"]))

    def artist(self, name: str) -> Palette:
        albums = self.by_artist.get(artist_key(name))
        if not albums:
            return fallback(name)
        top = albums[0]["colors"]
        body = vivid(top["primary"])
        accent = top.get("secondary") or ""
        # If the top album's pair is too close, borrow from the next album.
        for a in albums[1:]:
            if accent and contrast(accent, body) > 1.5:
                break
            accent = a["colors"]["primary"]
        if not accent or contrast(accent, body) <= 1.5:
            accent = PAPER if lum(body) < 0.3 else INK
        return Palette(body, vivid(accent) if accent not in (PAPER, INK) else accent, "shelf")

    def album(self, release_id: str, fallback_name: str) -> Palette:
        a = self.by_album.get(release_id)
        if not a:
            return fallback(fallback_name)
        c = a["colors"]
        return Palette(vivid(c["primary"]), vivid(c.get("secondary") or c["primary"]), "shelf")


def fallback(name: str) -> Palette:
    body, accent = FALLBACK[h("palette", name) % len(FALLBACK)]
    return Palette(body, accent, "fallback")


# ------------------------------------------------------------------- main --

def render(entry: dict, shelf: Shelf) -> str:
    kind = entry["kind"]
    uid = slugify(entry["path"])[:40] or "x"
    if kind == "artist":
        pal = shelf.artist(entry["name"])
        return artist_sticker(entry["name"], pal, uid=uid, layout=entry.get("layout"))
    if kind == "artist-template":
        return artist_sticker("Artist", fallback(entry.get("palette_seed", "template")), uid=uid,
                              layout=entry.get("layout", "badge"), placeholder=True)
    if kind == "number":
        return number_sticker(entry["name"], str(entry["number"]), shelf.artist(entry["name"]), uid=uid)
    if kind == "community":
        name = entry.get("name")
        pal = shelf.artist(name) if name else fallback(entry.get("palette_seed", "community"))
        return community_pass(name, pal, uid=uid)
    if kind == "poster":
        rid = entry.get("release_mbid")
        pal = shelf.album(rid, entry.get("title", "poster")) if rid else fallback(entry.get("palette_seed", "poster"))
        return poster(entry.get("title"), entry.get("artist"), pal, uid=uid, year=entry.get("year"))
    raise ValueError(f"unknown kind {kind!r} in manifest entry {entry}")


def write(path: Path, svg: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(svg, encoding="utf-8", newline="\n")


def samples(shelf: Shelf, n: int) -> list[dict]:
    """The most-played shelf artists and albums, for eyeballing layouts."""
    totals: dict[str, tuple[int, str]] = {}
    for key, albums in shelf.by_artist.items():
        totals[key] = (sum(a.get("play_count") or 0 for a in albums), albums[0]["artist"])
    top = sorted(totals.values(), reverse=True)[:n]
    out = [{"kind": "artist", "name": name, "path": f"artist/{slugify(name)}.svg"} for _, name in top]
    out += [{"kind": "community", "name": name, "path": f"community/{slugify(name)}.svg"}
            for _, name in top[:3]]
    albums = sorted(shelf.by_album.values(), key=lambda a: -(a.get("play_count") or 0))[:4]
    out += [{"kind": "poster", "release_mbid": a["id"], "title": a["title"], "artist": a["artist"],
             "year": a.get("release_year"), "path": f"poster/{a['id']}.svg"} for a in albums]
    # Fallback palette check: an artist not on the shelf.
    out.append({"kind": "artist", "name": "Not On The Shelf", "path": "artist/not-on-the-shelf.svg"})
    return out


def find_chrome() -> str | None:
    for p in (r"C:\Program Files\Google\Chrome\Application\chrome.exe",
              r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
              shutil.which("chrome"), shutil.which("google-chrome"), shutil.which("chromium")):
        if p and Path(p).exists():
            return p
    return None


def contact_sheet(svgs: list[Path], out_png: Path) -> None:
    """Lay every SVG out on a grey wall and screenshot it with headless Chrome."""
    chrome = find_chrome()
    if not chrome:
        print("no Chrome/Edge found; skipping PNG", file=sys.stderr)
        return
    cols = 4
    rows = math.ceil(len(svgs) / cols)
    cells = "".join(
        f'<figure><img src="{p.as_uri()}"><figcaption>{escape(p.relative_to(OUT).as_posix())}'
        f'</figcaption></figure>' for p in svgs)
    html = (f'<!doctype html><meta charset="utf-8"><style>body{{margin:0;background:#8a8f98;'
            f'font:12px sans-serif;display:grid;grid-template-columns:repeat({cols},320px);gap:8px;'
            f'padding:8px}}figure{{margin:0;text-align:center;color:#fff}}img{{width:320px;height:320px;'
            f'object-fit:contain}}</style>{cells}')
    shoot(chrome, html, out_png, 8 + cols * 328, 8 + rows * 350)
    print(f"wrote {out_png}")


def shoot(chrome: str, html: str, out_png: Path, width: int, height: int,
          transparent: bool = False) -> None:
    out_png.parent.mkdir(parents=True, exist_ok=True)
    page = out_png.with_suffix(".html")
    page.write_text(html, encoding="utf-8")
    cmd = [chrome, "--headless=new", "--disable-gpu", "--hide-scrollbars",
           "--allow-file-access-from-files", f"--screenshot={out_png}",
           f"--window-size={width},{height}"]
    if transparent:
        cmd.append("--default-background-color=00000000")  # ARGB: fully transparent
    subprocess.run([*cmd, page.as_uri()], check=True, capture_output=True, timeout=120)
    page.unlink()


def svg_size(svg: Path) -> tuple[int, int]:
    text = svg.read_text(encoding="utf-8")
    return (int(text.split('width="', 1)[1].split('"', 1)[0]),
            int(text.split('height="', 1)[1].split('"', 1)[0]))


def rasterise_each(svgs: list[Path], out_dir: Path, *, scale: float = 1,
                   transparent: bool = False, suffix: str = ".png") -> list[Path]:
    """One PNG per SVG. Opaque on a grey wall (so the white die-cut border shows)
    for reviewing; transparent at `scale` for shipping to the app."""
    chrome = find_chrome()
    if not chrome:
        print("no Chrome/Edge found; skipping PNG", file=sys.stderr)
        return []
    out = []
    for p in svgs:
        w, hh = svg_size(p)
        w, hh = round(w * scale), round(hh * scale)
        bg = "transparent" if transparent else "#8a8f98"
        html = (f'<!doctype html><style>html,body{{margin:0;background:{bg}}}img{{display:block}}'
                f'</style><img src="{p.as_uri()}" width="{w}" height="{hh}">')
        png = out_dir / p.relative_to(BUCKET_DIR).with_suffix(suffix)
        shoot(chrome, html, png, w, hh, transparent=transparent)
        out.append(png)
    print(f"wrote {len(out)} PNGs to {out_dir}")
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--manifest", type=Path, default=MANIFEST)
    ap.add_argument("--samples", type=int, default=0, help="also render the top N shelf artists to out/samples/")
    ap.add_argument("--png", action="store_true", help="rasterise a contact sheet with headless Chrome")
    args = ap.parse_args(argv)

    shelf = Shelf()
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    written: list[Path] = []
    for entry in manifest["art"]:
        p = BUCKET_DIR / entry["path"]
        write(p, render(entry, shelf))
        written.append(p)
    print(f"wrote {len(written)} manifest files to {BUCKET_DIR}")

    sample_paths: list[Path] = []
    if args.samples:
        for entry in samples(shelf, args.samples):
            p = OUT / "samples" / entry["path"]
            write(p, render(entry, shelf))
            sample_paths.append(p)
        print(f"wrote {len(sample_paths)} samples to {OUT / 'samples'}")

    if args.png:
        contact_sheet(written, OUT / "preview" / "manifest.png")
        rasterise_each(written, OUT / "preview" / "reward-art")
        if sample_paths:
            contact_sheet(sample_paths, OUT / "preview" / "samples.png")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
