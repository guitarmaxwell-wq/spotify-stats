"""Normalization: every source must land on the same event for the same play."""

import pytest

from ingest.schema import (
    DEFAULT_MIN_MS_PLAYED,
    InvalidPlayEvent,
    PlayEvent,
    Source,
    make_event,
)
from ingest.sources.lastfm_api import parse_track
from ingest.sources.spotify_export import parse_row
from ingest.sources.spotify_recent import parse_item


def test_three_sources_normalize_one_play_to_one_identity():
    """The same listen, as each API reports it, must agree on artist/track keys."""
    lastfm = parse_track({
        "artist": {"#text": "The Nat King Cole Trio", "mbid": "a1"},
        "album": {"#text": "After Midnight (Remastered)", "mbid": "b1"},
        "name": "Route 66 - Remastered",
        "mbid": "c1",
        "date": {"uts": "1600000000"},
    })
    spotify_live = parse_item({
        "played_at": "2020-09-13T12:26:40.123Z",
        "track": {
            "name": "Route 66 - Remastered 2019",
            "uri": "spotify:track:xyz",
            "duration_ms": 180000,
            "artists": [{"name": "Nat King Cole"}],
            "album": {"name": "After Midnight"},
        },
    })
    spotify_export = parse_row({
        "ts": "2020-09-13T12:26:40Z",
        "master_metadata_track_name": "Route 66 - Remastered",
        "master_metadata_album_artist_name": "Nat King Cole",
        "master_metadata_album_album_name": "After Midnight (Deluxe Edition)",
        "ms_played": 175000,
        "spotify_track_uri": "spotify:track:xyz",
    })

    for ev in (lastfm, spotify_live, spotify_export):
        assert ev.artist_key == "nat king cole"
        assert ev.track_key == "route 66"
        assert ev.album_key == "after midnight"

    # ...and the display forms are cleaned, not raw.
    assert lastfm.track == "Route 66"
    assert spotify_export.album == "After Midnight"


def test_timestamp_semantics_are_recorded_per_source():
    assert Source.TS_KIND[Source.LASTFM] == "start"
    assert Source.TS_KIND[Source.SPOTIFY_RECENT] == "end"
    assert Source.TS_KIND[Source.SPOTIFY_EXPORT] == "end"


@pytest.mark.parametrize("kwargs", [
    {"ts": 0, "artist": "A", "track": "T"},
    {"ts": None, "artist": "A", "track": "T"},
    {"ts": 100, "artist": "", "track": "T"},
    {"ts": 100, "artist": "A", "track": "   "},
])
def test_unusable_rows_are_rejected_not_silently_kept(kwargs):
    with pytest.raises(InvalidPlayEvent):
        make_event(source=Source.LASTFM, **kwargs)


def test_punctuation_only_names_survive_and_stay_distinct():
    """`¥$` and tracks called `?` are real rows; the normalizer folds them to "".

    Rejecting them loses every play of Vultures 1; folding them together merges
    unrelated artists. Both are worse than a raw fallback key.
    """
    vultures = make_event(ts=1, artist="¥$", track="BURN", source=Source.LASTFM)
    other = make_event(ts=1, artist="!!!", track="BURN", source=Source.LASTFM)

    assert vultures.artist_key == "¥$"
    assert vultures.artist_key != other.artist_key
    assert vultures.identity != other.identity


def test_a_punctuation_only_track_title_is_its_own_track():
    a = make_event(ts=1, artist="MF DOOM", track="?", source=Source.LASTFM)
    b = make_event(ts=1, artist="MF DOOM", track="...", source=Source.LASTFM)
    assert a.track_key and b.track_key and a.track_key != b.track_key


def test_album_is_optional_but_artist_and_track_are_not():
    ev = make_event(ts=100, artist="Nobody", track="Untitled Single",
                    source=Source.LASTFM, album=None)
    assert ev.album is None and ev.album_key == ""


def test_round_trip_through_json_preserves_every_field():
    ev = make_event(ts=1700000000, artist="Oasis", track="Wonderwall",
                    album="Morning Glory", source=Source.SPOTIFY_EXPORT,
                    ms_played=250000, duration_ms=258000,
                    artist_mbid="a", album_mbid="b", track_mbid="c",
                    foreign_id="spotify:track:1")
    assert PlayEvent.from_dict(__import__("json").loads(ev.to_json())) == ev


def test_null_fields_are_omitted_from_json_not_written_as_null():
    ev = make_event(ts=1, artist="A", track="T", source=Source.LASTFM)
    assert "ms_played" not in ev.to_json()


# --------------------------------------------------------------- ms_played --

def test_sources_without_ms_played_always_count():
    ev = make_event(ts=1, artist="A", track="T", source=Source.LASTFM)
    assert ev.ms_played is None
    assert ev.counts_as_listen() is True


def test_a_short_skip_does_not_count():
    ev = make_event(ts=1, artist="A", track="T", source=Source.SPOTIFY_EXPORT,
                    ms_played=9_000)
    assert ev.counts_as_listen() is False


def test_ten_seconds_does_not_count_thirty_does():
    short = make_event(ts=1, artist="A", track="T", source=Source.SPOTIFY_EXPORT,
                       ms_played=10_000)
    long = make_event(ts=1, artist="A", track="T", source=Source.SPOTIFY_EXPORT,
                      ms_played=DEFAULT_MIN_MS_PLAYED)
    assert short.counts_as_listen() is False
    assert long.counts_as_listen() is True


def test_a_track_shorter_than_the_threshold_can_still_be_unlocked():
    """Donuts is full of 20-second tracks; a 30s floor would lock it forever."""
    interlude = make_event(ts=1, artist="J Dilla", track="Intro",
                           source=Source.SPOTIFY_EXPORT,
                           ms_played=12_000, duration_ms=20_000)
    assert interlude.counts_as_listen() is True

    barely = make_event(ts=1, artist="J Dilla", track="Intro",
                        source=Source.SPOTIFY_EXPORT,
                        ms_played=4_000, duration_ms=20_000)
    assert barely.counts_as_listen() is False


def test_the_threshold_is_a_parameter_not_a_constant():
    ev = make_event(ts=1, artist="A", track="T", source=Source.SPOTIFY_EXPORT,
                    ms_played=15_000)
    assert ev.counts_as_listen(min_ms=30_000) is False
    assert ev.counts_as_listen(min_ms=10_000) is True


def test_a_long_play_marked_skipped_still_counts():
    """Skipping the outro of a 4-minute track is a listen, not a skip."""
    ev = parse_row({
        "ts": "2021-01-01T00:00:00Z",
        "master_metadata_track_name": "T",
        "master_metadata_album_artist_name": "A",
        "master_metadata_album_album_name": "Alb",
        "ms_played": 230_000,
        "skipped": True,
    })
    assert ev.counts_as_listen() is True


# ------------------------------------------------------------ export shapes --

def test_podcast_rows_are_dropped_not_treated_as_errors():
    assert parse_row({
        "ts": "2021-01-01T00:00:00Z",
        "master_metadata_track_name": None,
        "master_metadata_album_artist_name": None,
        "episode_name": "Some Podcast Ep 4",
        "ms_played": 900_000,
    }) is None


def test_the_account_data_export_format_is_also_understood():
    ev = parse_row({
        "endTime": "2021-05-03 17:20",
        "artistName": "Oasis",
        "trackName": "Wonderwall",
        "msPlayed": 258000,
    })
    assert ev.artist_key == "oasis"
    assert ev.album is None  # that format has no album field
    assert ev.source == Source.SPOTIFY_EXPORT


def test_now_playing_is_not_a_play():
    assert parse_track({
        "artist": {"#text": "Oasis"}, "name": "Wonderwall",
        "@attr": {"nowplaying": "true"},
    }) is None


def test_lastfm_empty_mbid_strings_become_none():
    ev = parse_track({
        "artist": {"#text": "Oasis", "mbid": ""},
        "album": {"#text": "Alb", "mbid": ""},
        "name": "Wonderwall", "mbid": "",
        "date": {"uts": "1600000000"},
    })
    assert ev.artist_mbid is None and ev.album_mbid is None and ev.track_mbid is None
