import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import TopBar from '../components/TopBar';
import { loadCollection, topBy } from '../data/collection';
import { theme } from '../theme';

const fmt = (n: number) => n.toLocaleString('en-US');
const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

export default function StatsScreen({ onBack }: { onBack: () => void }) {
  const collection = useMemo(loadCollection, []);
  const { stats, albums, genres, unresolved } = collection;

  const topArtists = useMemo(() => topBy(albums, (a) => a.artist, 8), [albums]);
  const topAlbums = useMemo(
    () => albums.slice().sort((a, b) => b.play_count - a.play_count).slice(0, 8),
    [albums]
  );
  const years = Math.max(
    1,
    (new Date(stats.last_play).getTime() - new Date(stats.first_play).getTime()) / 31557600000
  );

  return (
    <ScrollView style={styles.room} contentContainerStyle={{ paddingBottom: 48 }}>
      <TopBar title="STATS" subtitle={`generated ${day(collection.generated_at)}`} onBack={onBack} />
      <View style={styles.body}>
        <View style={styles.tiles}>
          <Tile big value={fmt(stats.total_plays)} label="plays" />
          <Tile big value={fmt(stats.distinct_artists)} label="artists" />
          <Tile value={fmt(stats.unlocked_count)} label="records earned" />
          <Tile value={fmt(stats.in_progress_count)} label="in progress" />
          <Tile value={fmt(genres.length)} label="crates" />
          <Tile value={`${Math.round(stats.total_plays / years / 365)}`} label="plays / day" />
        </View>

        <Text style={styles.range}>
          {day(stats.first_play)} → {day(stats.last_play)}
        </Text>

        <Section title="TOP ARTISTS">
          {topArtists.map((a, i) => (
            <Row key={a.label} rank={i + 1} name={a.label} value={`${fmt(a.plays)} plays`} />
          ))}
        </Section>

        <Section title="TOP ALBUMS">
          {topAlbums.map((a, i) => (
            <Row
              key={a.id}
              rank={i + 1}
              name={`${a.title}`}
              sub={a.artist}
              value={`${fmt(a.play_count)} plays`}
            />
          ))}
        </Section>

        <Section title="CRATES BY SIZE">
          {genres
            .slice()
            .sort((a, b) => b.album_count - a.album_count)
            .map((g, i) => (
              <Row key={g.id} rank={i + 1} name={g.label} value={`${g.album_count} albums`} />
            ))}
        </Section>

        <Text style={styles.note}>
          {unresolved.length} album{unresolved.length === 1 ? '' : 's'} could not be resolved to a
          tracklist and are left out of the shelf.
        </Text>
      </View>
    </ScrollView>
  );
}

function Tile({ value, label, big }: { value: string; label: string; big?: boolean }) {
  return (
    <View style={[styles.tile, big && styles.tileBig]}>
      <Text style={[styles.tileValue, big && { fontSize: 30 }]}>{value}</Text>
      <Text style={styles.tileLabel}>{label}</Text>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ marginTop: 26 }}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

function Row({ rank, name, sub, value }: { rank: number; name: string; sub?: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rank}>{String(rank).padStart(2, '0')}</Text>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowName} numberOfLines={1}>
          {name}
        </Text>
        {sub ? <Text style={styles.rowSub}>{sub}</Text> : null}
      </View>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  room: { flex: 1, backgroundColor: theme.room },
  body: { paddingHorizontal: 18, maxWidth: 560, width: '100%', alignSelf: 'center' },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 8 },
  tile: {
    backgroundColor: theme.card,
    borderWidth: 1,
    borderColor: theme.cardEdge,
    borderRadius: 12,
    padding: 14,
    minWidth: 98,
    flexGrow: 1,
  },
  tileBig: { minWidth: 150 },
  tileValue: { color: theme.ink, fontSize: 22, fontWeight: '900' },
  tileLabel: { color: theme.inkDim, fontSize: 12, marginTop: 2 },
  range: { color: theme.inkDim, fontSize: 13, marginTop: 14 },
  sectionTitle: { color: theme.gold, fontSize: 11, fontWeight: '800', letterSpacing: 2, marginBottom: 8 },
  card: {
    backgroundColor: theme.card,
    borderWidth: 1,
    borderColor: theme.cardEdge,
    borderRadius: 12,
    paddingVertical: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 9,
    paddingHorizontal: 14,
    gap: 12,
  },
  rank: { color: theme.inkFaint, fontSize: 12, fontWeight: '800', width: 22 },
  rowName: { color: theme.ink, fontSize: 15, fontWeight: '600' },
  rowSub: { color: theme.inkFaint, fontSize: 12 },
  rowValue: { color: theme.inkDim, fontSize: 13 },
  note: { color: theme.inkFaint, fontSize: 12, marginTop: 24, lineHeight: 18 },
});
