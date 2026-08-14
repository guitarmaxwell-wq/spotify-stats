import os

import pandas as pd
import streamlit as st

st.set_page_config(page_title="My Listening History", page_icon="🎧", layout="wide")

DATA_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "scrobbles.csv")


@st.cache_data
def load_data():
    df = pd.read_csv(DATA_PATH)
    df["played_at"] = pd.to_datetime(df["uts"], unit="s")
    df["year"] = df["played_at"].dt.year
    df["album"] = df["album"].fillna("(no album)")
    return df


df = load_data()
current_year = pd.Timestamp.now().year

st.title("🎧 My Listening History")
st.caption(
    f"{len(df):,} plays · {df['artist'].nunique():,} artists · "
    f"{df['played_at'].min():%b %Y} – {df['played_at'].max():%b %Y}"
)

tab_history, tab_artists, tab_albums, tab_this_year = st.tabs(
    ["Browse History", "Top Artists", "Top Albums", f"Top Artists of {current_year}"]
)

with tab_history:
    search = st.text_input("Search artist or track", "")
    filtered = df
    if search:
        mask = (
            df["artist"].str.contains(search, case=False, na=False)
            | df["track"].str.contains(search, case=False, na=False)
        )
        filtered = df[mask]
    st.write(f"{len(filtered):,} plays")
    st.dataframe(
        filtered[["played_at", "artist", "track", "album"]]
        .sort_values("played_at", ascending=False)
        .rename(columns={"played_at": "Played At", "artist": "Artist", "track": "Track", "album": "Album"}),
        use_container_width=True,
        hide_index=True,
    )

with tab_artists:
    top_n = st.slider("Show top", 5, 50, 20, key="artists_n")
    counts = df["artist"].value_counts().head(top_n)
    st.bar_chart(counts)
    st.dataframe(
        counts.rename_axis("Artist").reset_index(name="Plays"),
        use_container_width=True,
        hide_index=True,
    )

with tab_albums:
    top_n = st.slider("Show top", 5, 50, 20, key="albums_n")
    album_counts = (
        df.groupby(["artist", "album"]).size().reset_index(name="Plays")
        .sort_values("Plays", ascending=False)
        .head(top_n)
    )
    album_counts["label"] = album_counts["album"] + " — " + album_counts["artist"]
    st.bar_chart(album_counts.set_index("label")["Plays"])
    st.dataframe(
        album_counts[["artist", "album", "Plays"]].rename(columns={"artist": "Artist", "album": "Album"}),
        use_container_width=True,
        hide_index=True,
    )

with tab_this_year:
    year_df = df[df["year"] == current_year]
    st.write(f"{len(year_df):,} plays in {current_year}")
    top_n = st.slider("Show top", 5, 50, 20, key="this_year_n")
    counts = year_df["artist"].value_counts().head(top_n)
    st.bar_chart(counts)
    st.dataframe(
        counts.rename_axis("Artist").reset_index(name="Plays"),
        use_container_width=True,
        hide_index=True,
    )
