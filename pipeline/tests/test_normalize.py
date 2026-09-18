import pytest

from pipeline.normalize import artist_key, clean_title, group_key, slugify, title_key


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("She's Electric - Remastered", "She's Electric"),
        ("Some Might Say - Remastered", "Some Might Say"),
        ("Wonderwall - 2014 Remaster", "Wonderwall"),
        ("Rocks - Remastered 2009", "Rocks"),
        ("Kid A (Remastered)", "Kid A"),
        ("Blonde on Blonde (Deluxe Edition)", "Blonde on Blonde"),
        ("Rumours (Super Deluxe)", "Rumours"),
        ("Illmatic (Deluxe Version)", "Illmatic"),
        ("Nevermind (Bonus Track Version)", "Nevermind"),
        ("Purple Rain (Explicit)", "Purple Rain"),
        ("Pet Sounds (Mono)", "Pet Sounds"),
        ("Aja (Expanded Edition)", "Aja"),
        ("Thriller (25th Anniversary Edition)", "Thriller"),
        ("Grace (Legacy Edition)", "Grace"),
        # multiple stacked suffixes
        (
            "(What's The Story) Morning Glory? (Deluxe Remastered Edition)",
            "(What's The Story) Morning Glory?",
        ),
        ("Definitely Maybe (Deluxe) (Remastered)", "Definitely Maybe"),
    ],
)
def test_clean_title_strips_packaging_noise(raw, expected):
    assert clean_title(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [
        "(What's The Story) Morning Glory?",
        "Live at the Apollo",  # live is identity, not packaging
        "Stan (Remix)",  # a remix is a different recording
        "Songs in the Key of Life",
        "Paid in Full (Seven Minutes of Madness - The Coldcut Remix)",
    ],
)
def test_clean_title_preserves_identity(raw):
    assert clean_title(raw) == raw


def test_clean_title_strips_features():
    assert clean_title("Otis (feat. Otis Redding)") == "Otis"
    assert clean_title("Crew - feat. Brent Faiyaz") == "Crew"


def test_title_key_is_case_and_punctuation_insensitive():
    assert title_key("Ms. Fat Booty") == title_key("Ms Fat Booty")
    assert title_key("The Light") == title_key("Light")
    assert title_key("Café Bustelo") == title_key("Cafe Bustelo")
    assert title_key("Me & You") == title_key("Me and You")


def test_title_key_keeps_distinct_titles_distinct():
    assert title_key("Intro") != title_key("Outro")
    assert title_key("Interlude") != title_key("Intermission")


@pytest.mark.parametrize(
    "a,b",
    [
        ("The Nat King Cole Trio", "Nat King Cole"),
        ("Nat King Cole Trio", "Nat King Cole"),
        ("The Beatles", "Beatles"),
        ("Beyoncé", "Beyonce"),
        ("Tyler, The Creator", "Tyler"),
        ("Jay-Z & Kanye West", "Jay Z"),
        ("Miles Davis feat. John Coltrane", "Miles Davis"),
    ],
)
def test_artist_key_folds_variants(a, b):
    assert artist_key(a) == artist_key(b)


def test_artist_key_keeps_distinct_artists_distinct():
    assert artist_key("Nas") != artist_key("Nasty Nas")
    assert artist_key("The Roots") != artist_key("Roots Manuva")


def test_group_key_merges_the_same_album_written_two_ways():
    a = group_key("Oasis", "(What's The Story) Morning Glory? (Deluxe Remastered Edition)")
    b = group_key("Oasis", "(What's the Story) Morning Glory?")
    assert a == b


def test_slugify():
    assert slugify("J Dilla", "Donuts") == "j-dilla-donuts"
