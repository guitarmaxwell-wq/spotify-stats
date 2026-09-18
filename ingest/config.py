"""Configuration from the environment. No credential is ever committed.

Every value here is read from the environment or from a gitignored ``.env`` at
the repo root. ``.env.example`` documents what each one is and where the user
creates it; it holds no values.

Note what is *not* here: a Spotify client secret. The mobile client uses the
PKCE flow precisely so there is no secret to ship, and a secret in a published
app is a secret you have given away. The CLI poller uses an access token the app
obtained; it never sees a secret either.
"""

from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / ".env"


def load_dotenv(path=ENV_FILE) -> dict:
    """Read a ``KEY=value`` file into os.environ without overwriting anything.

    Deliberately tiny — a dependency to parse six lines is not worth it, and
    existing environment variables always win so CI can override.
    """
    path = Path(path)
    loaded = {}
    if not path.exists():
        return loaded
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip('"').strip("'")
        loaded[key] = value
        os.environ.setdefault(key, value)
    return loaded


def get(name: str, default=None):
    load_dotenv()
    return os.environ.get(name, default)


def lastfm_api_key() -> str | None:
    return get("LASTFM_API_KEY")


def lastfm_username() -> str | None:
    return get("LASTFM_USERNAME")


def spotify_client_id() -> str | None:
    """The public PKCE client id. Public, but still not committed.

    Absent by default: the user must create an app at
    https://developer.spotify.com/dashboard and paste the id. There is no
    shared or stub id that would work — Spotify ties the redirect URI and the
    25-user allowlist to that specific app.
    """
    return get("SPOTIFY_CLIENT_ID")


def spotify_redirect_uri() -> str:
    return get("SPOTIFY_REDIRECT_URI", "crates://auth")


def missing(*names: str) -> list[str]:
    return [n for n in names if not get(n)]
