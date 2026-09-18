from pipeline.completion import build_matching, summarize
from pipeline.normalize import title_key
from pipeline.resolve import tracklist_of

CANON = ["Intro", "Workinonit", "Waves", "Light My Fire", "The New"]


def played(*titles):
    return [title_key(t) for t in titles]


def test_exact_and_noisy_titles_match():
    m = build_matching(CANON, played("Intro", "Workinonit - Remastered", "waves",
                                     "Light My Fire", "The New"))
    s = summarize(m)
    assert s["played_tracks"] == 5
    assert s["unlocked"] is True
    assert s["missing_tracks"] == []
    assert s["completion"] == 1.0


def test_missing_track_blocks_unlock():
    m = build_matching(CANON, played("Intro", "Workinonit", "Waves", "The New"))
    s = summarize(m)
    assert s["unlocked"] is False
    assert s["played_tracks"] == 4
    assert s["missing_tracks"] == ["Light My Fire"]
    assert s["completion"] == 0.8


def test_extra_plays_not_on_tracklist_are_ignored():
    m = build_matching(CANON, played(*CANON, "Some Bonus Track", "Another Thing"))
    s = summarize(m)
    assert s["total_tracks"] == 5
    assert s["played_tracks"] == 5
    assert s["unlocked"] is True


def test_one_played_track_cannot_satisfy_two_canonical_slots():
    canon = ["Intro", "Intro (Skit)"]
    m = build_matching(canon, played("Intro"))
    s = summarize(m)
    assert s["played_tracks"] == 1
    assert s["unlocked"] is False


def test_instrumental_suffix_matches_the_same_slot():
    m = build_matching(["Jay Dee 1", "Jay Dee 2"],
                       played("Jay Dee 1 - Instrumental", "Jay Dee 2 - Instrumental"))
    s = summarize(m)
    assert s["unlocked"] is True


def test_vocal_and_instrumental_stay_in_separate_slots():
    canon = ["Runnin'", "Runnin' (Instrumental)"]
    m = build_matching(canon, played("Runnin'", "Runnin' - Instrumental"))
    s = summarize(m)
    assert s["played_tracks"] == 2
    # And a single vocal play must not fill both slots.
    assert summarize(build_matching(canon, played("Runnin'")))["played_tracks"] == 1


def test_empty_tracklist_is_never_unlocked():
    s = summarize(build_matching([], played("Anything")))
    assert s["unlocked"] is False
    assert s["completion"] == 0.0


def test_unlocked_at_is_the_completing_play():
    m = build_matching(CANON, played(*CANON))
    stamps = {
        title_key("Intro"): 100,
        title_key("Workinonit"): 400,
        title_key("Waves"): 200,
        title_key("Light My Fire"): 900,  # the play that completes it
        title_key("The New"): 300,
    }
    s = summarize(m, stamps)
    assert s["unlocked_uts"] == 900


def test_no_unlocked_at_when_not_unlocked():
    m = build_matching(CANON, played("Intro"))
    s = summarize(m, {title_key("Intro"): 100})
    assert s["unlocked_uts"] is None


def test_fuzzy_match_is_counted_as_fuzzy():
    m = build_matching(["Nuthin' but a G Thang"], played("Nuthin but a G Thing"))
    s = summarize(m)
    assert s["played_tracks"] == 1
    assert s["fuzzy_matches"] == 1


def test_unrelated_short_titles_do_not_fuzzy_match():
    m = build_matching(["Outro"], played("Intro"))
    assert summarize(m)["played_tracks"] == 0


def test_tracklist_of_flattens_multi_disc_and_skips_data_tracks():
    release = {
        "media": [
            {"tracks": [{"title": "A1"}, {"title": "A2"}]},
            {"tracks": [{"title": "B1"}, {"title": "Video", "data-track": True}]},
        ]
    }
    assert tracklist_of(release) == ["A1", "A2", "B1"]
    assert tracklist_of(None) == []


def test_tracklist_falls_back_to_recording_title():
    release = {"media": [{"tracks": [{"title": "", "recording": {"title": "Real Name"}}]}]}
    assert tracklist_of(release) == ["Real Name"]
