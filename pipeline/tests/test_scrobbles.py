import textwrap

from pipeline.scrobbles import iso, load_groups

CSV = textwrap.dedent(
    """\
    uts,utc_time,artist,artist_mbid,album,album_mbid,track,track_mbid
    "1000","x","Oasis","aid","(What's The Story) Morning Glory? (Deluxe Remastered Edition)","","She's Electric - Remastered",""
    "1100","x","Oasis","aid","(What's the Story) Morning Glory?","alb1","She's Electric","t1"
    "1200","x","Oasis","aid","(What's the Story) Morning Glory?","alb1","Wonderwall","t2"
    "1300","x","Nat King Cole","","After Midnight","","Route 66",""
    "1400","x","The Nat King Cole Trio","","After Midnight","","Sweet Lorraine",""
    "1500","x","Nobody","","","","Untitled Single",""
    """
)


def test_groups_fold_album_and_artist_variants(tmp_path):
    p = tmp_path / "s.csv"
    p.write_text(CSV, encoding="utf-8")
    groups, stats = load_groups(p)

    assert stats["total_plays"] == 6
    assert stats["rows_without_album"] == 1
    assert stats["distinct_artists"] == 3  # oasis, nat king cole, nobody
    assert stats["first_play"] == iso(1000)
    assert stats["last_play"] == iso(1500)

    by_album = {g.album_key: g for g in groups}
    assert len(groups) == 2  # the no-album row makes no group

    oasis = by_album["what s the story morning glory"]
    assert oasis.play_count == 3
    assert oasis.distinct_tracks == 2  # the remastered spelling folds in
    assert oasis.best_album_mbid() == "alb1"
    assert oasis.tracks["she s electric"].play_count == 2
    assert oasis.tracks["she s electric"].first_uts == 1000

    cole = by_album["after midnight"]
    assert cole.distinct_tracks == 2  # both artist spellings land in one group


def test_groups_are_ordered_by_distinct_tracks(tmp_path):
    p = tmp_path / "s.csv"
    p.write_text(CSV, encoding="utf-8")
    groups, _ = load_groups(p)
    counts = [g.distinct_tracks for g in groups]
    assert counts == sorted(counts, reverse=True)
