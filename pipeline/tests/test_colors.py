import io

import pytest

from pipeline.colors import (
    CHROMA_MIN,
    CHROMA_TINT,
    DERIVED,
    DOMINANT,
    MIN_CONTRAST,
    MIN_DELTA_E,
    NEUTRAL_FALLBACK,
    SATURATED,
    SATURATED_DERIVED,
    SATURATED_PARTNER,
    UI_BACKGROUND,
    ColorPair,
    chroma,
    contrast_ratio,
    delta_e,
    ensure_contrast,
    extract_colors,
    hex_to_rgb,
    is_color,
    make_pair,
    rgb_to_hex,
    saturation,
)

Image = pytest.importorskip("PIL.Image")


def _png(pixels, size=(64, 64)):
    """Render a solid or banded image and return PNG bytes.

    ``pixels`` is a list of (rgb, fraction) bands stacked top to bottom.
    """
    img = Image.new("RGB", size)
    y = 0
    for rgb, frac in pixels:
        h = max(1, round(size[1] * frac))
        for yy in range(y, min(size[1], y + h)):
            for xx in range(size[0]):
                img.putpixel((xx, yy), rgb)
        y += h
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _readable(hex_color):
    return contrast_ratio(hex_to_rgb(hex_color), hex_to_rgb(UI_BACKGROUND)) >= MIN_CONTRAST - 1e-9


# -- primitives ------------------------------------------------------------

def test_hex_roundtrip_and_shorthand():
    assert rgb_to_hex(hex_to_rgb("#ff8800")) == "#ff8800"
    assert hex_to_rgb("fff") == (255, 255, 255)
    with pytest.raises(ValueError):
        hex_to_rgb("#12345")


def test_contrast_ratio_is_wcag():
    # white on black is the 21:1 extreme
    assert contrast_ratio((255, 255, 255), (0, 0, 0)) == pytest.approx(21.0, abs=0.01)
    assert contrast_ratio((10, 10, 10), (10, 10, 10)) == pytest.approx(1.0)


def test_ensure_contrast_lifts_dark_colors_and_keeps_hue():
    dark_navy = (8, 10, 40)
    assert not _readable(rgb_to_hex(dark_navy))
    lifted, adjusted = ensure_contrast(dark_navy)
    assert adjusted
    assert _readable(rgb_to_hex(lifted))
    # still blue: blue remains the dominant channel
    assert lifted[2] > lifted[0] and lifted[2] > lifted[1]


def test_ensure_contrast_leaves_bright_colors_alone():
    bright = (240, 240, 235)
    out, adjusted = ensure_contrast(bright)
    assert out == bright and adjusted is False


def test_pure_black_still_becomes_visible():
    out, adjusted = ensure_contrast((0, 0, 0))
    assert adjusted and _readable(rgb_to_hex(out))


# -- pair construction -----------------------------------------------------

def test_two_distinct_clusters_are_used_as_is():
    pair = make_pair([((230, 40, 40), 500), ((30, 60, 220), 300)])
    assert pair.strategy == SATURATED
    assert _readable(pair.primary) and _readable(pair.secondary)
    assert delta_e(hex_to_rgb(pair.primary), hex_to_rgb(pair.secondary)) >= MIN_DELTA_E


def test_a_pair_that_converges_while_being_lifted_is_not_shipped():
    """Two different near-blacks both lift to the same grey — that is a flat bar.

    They are far apart before contrast correction, so checking the raw colours
    would pass them. The check has to happen on what actually ships.
    """
    pair = make_pair([((2, 2, 2), 900), ((16, 14, 15), 400)])
    assert delta_e(hex_to_rgb(pair.primary), hex_to_rgb(pair.secondary)) >= MIN_DELTA_E


def _colourful(hex_color):
    return chroma(hex_to_rgb(hex_color)) >= CHROMA_MIN


def test_lab_chroma_is_used_not_hls_saturation():
    """HLS saturation is fooled by muted olive and by near-black noise alike."""
    assert saturation((6, 10, 11)) > 0.25       # HLS calls near-black colourful
    assert chroma((109, 129, 93)) > CHROMA_MIN  # ...and muted olive drab
    assert saturation((109, 129, 93)) < 0.25    # which is backwards both ways


def test_near_black_noise_is_not_a_colour():
    """#060a0b is three channels five levels apart, not a teal."""
    assert not is_color((6, 10, 11))
    assert not is_color((32, 39, 37))


def test_paper_white_is_not_a_colour():
    assert not is_color((255, 255, 255))
    assert not is_color((236, 236, 236))


def test_a_dark_but_real_colour_is_judged_after_lifting():
    """Lab chroma is compressed at low lightness, so raw clusters read as mud.

    *Come to My Garden*'s dark olive measures 7 raw and 21 once lifted onto the
    contrast floor — and the lifted colour is the one the app renders.
    """
    dark_olive = (30, 28, 18)
    assert chroma(dark_olive) < CHROMA_MIN
    assert is_color(dark_olive)
    assert chroma(ensure_contrast(dark_olive)[0]) > CHROMA_MIN


def test_lifting_near_black_manufactures_a_colour_that_is_not_there():
    """Regression, and the reason for the lightness gate.

    *Aquemini* quantizes to #040601 — black with a rounding error. Lifting that
    onto the contrast floor yields a confident green (chroma 51) that is not on
    the sleeve, and *Come to My Garden* likewise produced a vivid magenta out
    of #010001. The gate rejects them before the lift can invent a hue.
    """
    for near_black in ((4, 6, 1), (1, 0, 1), (0, 1, 2)):
        assert chroma(ensure_contrast(near_black)[0]) > 40  # the lift invents one
        assert not is_color(near_black)                     # ...and we decline it


def test_black_with_rounding_noise_is_told_apart_from_a_dark_colour():
    """Both are dark; only one has any colour in it before it is lifted.

    ``#101918`` is *All Eyez on Me* — a sleeve that is 70% near-black, which
    led with an invented teal until this gate existed.
    """
    assert not is_color((16, 25, 24))   # chroma 2.4 raw: black, rounded
    assert is_color((30, 28, 18))       # chroma 7.1 raw: a real dark olive


def test_muted_photography_is_not_a_colour():
    assert not is_color((113, 132, 145))
    assert not is_color((133, 148, 160))


def test_near_black_noise_never_leads_the_pair():
    """Regression: an all-black sleeve was producing a teal bar."""
    clusters = [((6, 10, 11), 3790), ((32, 39, 37), 2150), ((145, 91, 72), 840)]
    pair = make_pair(clusters)
    r, g, b = hex_to_rgb(pair.primary)
    assert r > b, pair                  # the brown, not the lifted near-black
    assert pair.strategy in (SATURATED, SATURATED_DERIVED)


def test_both_ends_come_from_the_sleeve_colours_not_the_white_border():
    """Regression: gold-to-white rendered as a beige smear.

    Demoting white out of the primary slot only moved it into the secondary.
    """
    clusters = [
        ((255, 255, 255), 1590),   # the scan's white surround, still the heaviest
        ((213, 150, 2), 1570),     # gold
        ((235, 219, 1), 1490),     # yellow
    ]
    pair = make_pair(clusters)
    assert pair.strategy == SATURATED
    assert _colourful(pair.primary) and _colourful(pair.secondary), pair
    assert "#ffffff" not in (pair.primary, pair.secondary)


def test_a_single_colour_on_a_white_sleeve_is_tinted_not_paired_with_white():
    clusters = [((255, 255, 255), 6840), ((233, 220, 185), 1390), ((214, 224, 220), 440)]
    pair = make_pair(clusters)
    assert pair.strategy == SATURATED_DERIVED
    assert _colourful(pair.primary) and _colourful(pair.secondary), pair


def test_a_colour_too_small_to_lead_can_still_partner():
    """2% of the sleeve colours the gradient; it does not headline it."""
    clusters = [((255, 255, 255), 4840), ((0, 0, 0), 3990), ((173, 15, 15), 200)]
    pair = make_pair(clusters)
    assert pair.strategy == SATURATED_PARTNER
    assert pair.primary == "#ffffff"
    assert _colourful(pair.secondary), pair


def test_a_muted_sleeve_keeps_its_tint_at_both_ends():
    """A washed-out photo has no real colour, but it is not neutral grey."""
    clusters = [((113, 132, 145), 3710), ((0, 0, 0), 2530), ((88, 101, 109), 740)]
    pair = make_pair(clusters)
    assert pair.strategy == DERIVED
    for hexv in (pair.primary, pair.secondary):
        assert chroma(hex_to_rgb(hexv)) >= CHROMA_TINT, pair


def test_a_genuinely_white_sleeve_stays_white():
    """The White Album must not be given a colour it does not have."""
    pair = make_pair([((255, 255, 255), 6000), ((20, 20, 20), 3000)])
    assert pair.primary == "#ffffff"
    assert pair.strategy == DOMINANT
    for hexv in (pair.primary, pair.secondary):
        assert chroma(hex_to_rgb(hexv)) < CHROMA_TINT, pair


def test_a_faint_colour_speck_is_not_promoted():
    """A handful of coloured pixels is not the album's colour."""
    clusters = [((255, 255, 255), 9000), ((20, 20, 20), 3000), ((173, 15, 15), 20)]
    pair = make_pair(clusters)
    assert pair.strategy == DOMINANT
    assert not _colourful(pair.primary) and not _colourful(pair.secondary), pair


def test_the_primary_goes_by_presence_and_the_partner_by_colourfulness():
    """The two slots do different jobs, so they are ordered differently."""
    clusters = [
        ((200, 40, 40), 5000),   # red: the most present colour -> primary
        ((90, 110, 150), 2000),  # muted blue: heavier, but drab
        ((40, 200, 90), 1500),   # vivid green: lighter, but it makes a gradient
    ]
    pair = make_pair(clusters)
    assert pair.strategy == SATURATED
    r, g, b = hex_to_rgb(pair.primary)
    assert r > g and r > b, pair
    r, g, b = hex_to_rgb(pair.secondary)
    assert g > r and g > b, pair


def test_near_identical_clusters_do_not_collapse_the_gradient():
    """Single-colour sleeve: the second cluster is the same colour + noise."""
    pair = make_pair([((200, 30, 30), 900), ((202, 32, 31), 40)])
    assert pair.strategy == SATURATED_DERIVED
    assert pair.primary != pair.secondary
    assert delta_e(hex_to_rgb(pair.primary), hex_to_rgb(pair.secondary)) >= MIN_DELTA_E


def test_never_returns_null_even_with_no_clusters():
    pair = make_pair([])
    assert pair.primary and pair.secondary
    assert pair.strategy == NEUTRAL_FALLBACK
    assert _readable(pair.primary) and _readable(pair.secondary)


def test_colors_always_readable_on_the_dark_ui():
    for clusters in (
        [((0, 0, 0), 100)],                       # all black sleeve
        [((5, 5, 5), 100), ((9, 9, 9), 50)],      # two near-blacks
        [((255, 255, 255), 100)],                 # all white sleeve
        [((10, 10, 10), 100), ((250, 250, 250), 90)],
    ):
        pair = make_pair(clusters)
        assert _readable(pair.primary), (clusters, pair)
        assert _readable(pair.secondary), (clusters, pair)
        assert delta_e(hex_to_rgb(pair.primary), hex_to_rgb(pair.secondary)) >= MIN_DELTA_E


# -- end to end over real images ------------------------------------------

def test_white_album_gets_a_usable_pair():
    """The White Album: an essentially blank sleeve must not yield a flat bar."""
    data = _png([((246, 245, 242), 1.0)])
    pair = extract_colors(data)
    assert pair.strategy == DERIVED
    assert _readable(pair.primary) and _readable(pair.secondary)
    assert delta_e(hex_to_rgb(pair.primary), hex_to_rgb(pair.secondary)) >= MIN_DELTA_E


def test_single_flat_color_sleeve():
    data = _png([((18, 92, 160), 1.0)])
    pair = extract_colors(data)
    assert pair.primary != pair.secondary
    assert _readable(pair.primary) and _readable(pair.secondary)


def test_two_band_sleeve_extracts_both_bands():
    data = _png([((220, 50, 40), 0.6), ((40, 70, 200), 0.4)])
    pair = extract_colors(data)
    assert pair.strategy == SATURATED
    p, s = hex_to_rgb(pair.primary), hex_to_rgb(pair.secondary)
    assert p[0] > p[2]   # dominant band is the red one
    assert s[2] > s[0]   # partner is the blue one


def test_unreadable_bytes_fall_back_instead_of_raising():
    pair = extract_colors(b"not an image")
    assert isinstance(pair, ColorPair)
    assert pair.strategy == NEUTRAL_FALLBACK
    assert pair.primary and pair.secondary


def test_missing_image_falls_back():
    pair = extract_colors(None)
    assert pair.as_dict() == {"primary": pair.primary, "secondary": pair.secondary}
    assert pair.primary and pair.secondary
