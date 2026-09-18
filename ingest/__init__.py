"""Listening-history ingestion.

Three sources, one schema. See ``ingest/README.md`` for what each source can and
cannot do — the differences are not cosmetic and the UI is expected to be honest
about them.

* ``ingest.sources.lastfm_api``     -- full paginated history from a username.
* ``ingest.sources.spotify_recent`` -- forward-only sync, last ~50 plays per poll.
* ``ingest.sources.spotify_export`` -- one-off backfill from the GDPR zip.
* ``ingest.sources.lastfm_csv``     -- the existing ``data/scrobbles.csv`` export.
"""

from .schema import PlayEvent, Source
from .store import PlayStore

__all__ = ["PlayEvent", "Source", "PlayStore"]
