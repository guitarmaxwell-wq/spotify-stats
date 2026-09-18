"""Two scrobble groups that resolve to the same release are one album.

Regression: `data/collection.json` once held 815 albums with only 808 distinct
ids, because the normalizer cannot fold every artist variant ("Cordae" vs
"YBN Cordae") or edition suffix ("(Extended Version)"). Each duplicate split
the play set in half, undercounting completion and suppressing real unlocks.
"""

import pytest

from pipeline.build import assert_unique_ids, build_album, use_release_display
from pipeline.genres import GenreMapper
from pipeline.resolve import Resolution, credit_name
from pipeline.scrobbles import AlbumGroup, PlayedTrack, merge_group


def group(artist, album, tracks):
    """tracks: {display_title: (play_count, first_uts)}"""
    g = AlbumGroup(artist_key=artist.lower(), album_key=album.lower(),
                   artist=artist, album=album)
    for title, (count, uts) in tracks.items():
        g.tracks[title.lower()] = PlayedTrack(key=title.lower(), display=title,
                                              play_count=count, first_uts=uts)
        g.play_count += count
    g.first_uts = min(u for _, u in tracks.values())
    g.last_uts = max(u for _, u in tracks.values())
    g._artist_names[artist] = 1
    g._album_names[album] = 1
    return g


RELEASE = {
    "id": "45864bb4-0000-0000-0000-000000000000",
    "title": "The Lost Boy",
    "artist-credit": [{"name": "Cordae"}],
    "media": [{"tracks": [{"title": t} for t in ("Wintertime", "Bad Idea", "RNP")]}],
}


class NullMB:
    def release_group(self, mbid):
        return None

    def artist(self, mbid):
        return None


def _build(g, res=None):
    res = res or Resolution(RELEASE, "musicbrainz_mbid", None,
                            ["Wintertime", "Bad Idea", "RNP"])
    return build_album(g, res, NullMB(), GenreMapper(), fetch_genres=False,
                       resolver=None, cache=None, with_colors=False)


# -- the union itself -------------------------------------------------------

def test_merge_unions_tracks_and_sums_plays():
    a = group("Cordae", "The Lost Boy", {"Wintertime": (3, 100), "Bad Idea": (2, 110)})
    b = group("YBN Cordae", "The Lost Boy", {"Bad Idea": (1, 90), "RNP": (4, 300)})
    merged = merge_group(a, b)

    assert set(merged.tracks) == {"wintertime", "bad idea", "rnp"}
    assert merged.play_count == 10
    assert merged.tracks["bad idea"].play_count == 3
    assert merged.tracks["bad idea"].first_uts == 90   # earlier of the two
    assert merged.first_uts == 90 and merged.last_uts == 300


def test_split_plays_unlock_the_album_once_merged():
    a = group("Cordae", "The Lost Boy", {"Wintertime": (3, 100), "Bad Idea": (2, 110)})
    b = group("YBN Cordae", "The Lost Boy", {"RNP": (4, 300)})

    before = _build(a)
    assert before["played_tracks"] == 2 and before["unlocked"] is False

    after = _build(merge_group(a, b))
    assert after["played_tracks"] == 3
    assert after["unlocked"] is True
    assert after["completion"] == 1.0
    assert after["play_count"] == 9


def test_unlocked_at_is_recomputed_from_the_union_not_one_half():
    """The completing play may live in the group that was processed second."""
    a = group("Cordae", "The Lost Boy", {"Wintertime": (1, 100), "Bad Idea": (1, 110)})
    b = group("YBN Cordae", "The Lost Boy", {"RNP": (1, 500)})
    after = _build(merge_group(a, b))
    assert after["unlocked_at"] == "1970-01-01T00:08:20Z"  # uts 500, the last first-play


def test_merging_keeps_a_single_id():
    a = group("Cordae", "The Lost Boy", {"Wintertime": (1, 100)})
    b = group("YBN Cordae", "The Lost Boy", {"RNP": (1, 200)})
    assert _build(a)["id"] == _build(b)["id"] == RELEASE["id"]


# -- display name resolution -----------------------------------------------

def test_merged_record_is_named_after_the_release():
    album = _build(group("YBN Cordae", "The Lost Boy (Extended Version)",
                         {"Wintertime": (1, 100)}))
    use_release_display(album, RELEASE)
    assert album["artist"] == "Cordae"
    assert album["title"] == "The Lost Boy"


def test_release_display_falls_back_when_the_release_says_nothing():
    album = _build(group("Nujabes", "Departure", {"Wintertime": (1, 100)}))
    use_release_display(album, {"id": "x"})
    assert album["artist"] == "Nujabes" and album["title"] == "Departure"


def test_credit_name_joins_collaborators():
    rel = {"artist-credit": [
        {"name": "Nujabes", "joinphrase": " & "},
        {"name": "Fat Jon"},
    ]}
    assert credit_name(rel) == "Nujabes & Fat Jon"


# -- the guard rail ---------------------------------------------------------

def test_assert_unique_ids_passes_on_distinct_ids():
    assert_unique_ids([{"id": "a", "artist": "x", "title": "y"},
                       {"id": "b", "artist": "x", "title": "z"}])


def test_assert_unique_ids_fails_loudly_on_duplicates():
    albums = [
        {"id": "45864bb4", "artist": "Cordae", "title": "The Lost Boy"},
        {"id": "45864bb4", "artist": "YBN Cordae", "title": "The Lost Boy"},
    ]
    with pytest.raises(ValueError) as exc:
        assert_unique_ids(albums)
    assert "45864bb4" in str(exc.value)
    assert "YBN Cordae" in str(exc.value)  # names the offenders, not just the count
