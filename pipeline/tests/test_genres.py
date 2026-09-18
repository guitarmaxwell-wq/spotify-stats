from pipeline.genres import GenreMapper, extract_tags


def test_maps_raw_tags_onto_crates():
    m = GenreMapper()
    assert m.classify([("boom bap", 5), ("hip hop", 9)])[0] == "hip-hop"
    assert m.classify([("hard bop", 3)])[0] == "jazz"
    assert m.classify([("neo soul", 4)])[0] == "rnb-soul"
    assert m.classify([("britpop", 6), ("rock", 3)])[0] == "rock"
    assert m.classify([("deep house", 2)])[0] == "electronic"
    assert m.classify([("field recording", 2)])[0] == "ambient"
    assert m.classify([("roots reggae", 2)])[0] == "world"


def test_unknown_tags_fall_back():
    m = GenreMapper()
    assert m.classify([("zzzz unclassifiable", 1)])[0] == m.fallback
    assert m.classify([])[0] == m.fallback


def test_vocabulary_stays_small():
    m = GenreMapper()
    assert 8 <= len(m.order) <= 15


def test_extract_tags_weights_curated_genres_higher():
    ent = {"genres": [{"name": "jazz", "count": 2}], "tags": [{"name": "rock", "count": 2}]}
    tags = dict(extract_tags(ent))
    assert tags["jazz"] > tags["rock"]
