# My Listening History

A Streamlit dashboard for exploring ~136k plays of personal listening history
(April 2020 – present).

**Live app:** https://spotify-stats-yqqxsumtpjygihoxf22tm4.streamlit.app/

## Views

- **Browse History** — searchable table of every play
- **Top Artists** — most-played artists, all time
- **Top Albums** — most-played albums, all time
- **Top Artists of {year}** — current year only

## Running it locally

Requires Python 3.9+.

```bash
git clone https://github.com/guitarmaxwell-wq/spotify-stats.git
cd spotify-stats
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
streamlit run app.py
```

Opens at http://localhost:8501.

On Windows, replace `source venv/bin/activate` with `venv\Scripts\activate`.

## Deploying changes

The live app redeploys automatically on every push to `main`:

```bash
git add .
git commit -m "your message"
git push
```

Takes a minute or two to rebuild. No need to touch the Streamlit Cloud dashboard.

To push from a new machine you'll need git authenticated first — easiest is
[GitHub CLI](https://cli.github.com): `brew install gh && gh auth login`.

## The data

`data/scrobbles.csv` is a Last.fm scrobble export (not a native Spotify export),
covering Spotify plays scrobbled to Last.fm. Columns:

| Column | Meaning |
|---|---|
| `uts` | Unix timestamp of the play |
| `utc_time` | Human-readable timestamp |
| `artist`, `album`, `track` | Names |
| `*_mbid` | MusicBrainz IDs (often blank, unused) |

Note there's no play-duration field, so "most listened to" means **play count**,
not time listened.

The file is a point-in-time snapshot. To refresh it, re-export from Last.fm and
replace `data/scrobbles.csv`.
