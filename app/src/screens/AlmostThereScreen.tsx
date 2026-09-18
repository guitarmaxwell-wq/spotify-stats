import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import RecordSleeve from '../components/RecordSleeve';
import AlbumDetail from '../components/AlbumDetail';
import ProgressGradientBar, { albumAccent } from '../components/ProgressGradientBar';
import TopBar from '../components/TopBar';
import { almostThere, loadCollection } from '../data/collection';
import { theme } from '../theme';
import type { Album } from '../types';

function AlmostThereRow({ album, onOpen }: { album: Album; onOpen: (a: Album) => void }) {
  const missing = album.total_tracks - album.played_tracks;
  const accent = albumAccent(album);
  return (
    <Pressable style={styles.card} onPress={() => onOpen(album)}>
      <RecordSleeve album={album} size={74} showLock={false} />
      <View style={styles.info}>
        <Text style={styles.title} numberOfLines={1}>
          {album.title}
        </Text>
        <Text style={styles.artist} numberOfLines={1}>
          {album.artist}
        </Text>
        <ProgressGradientBar album={album} />
        <Text style={styles.missing} numberOfLines={2}>
          {missing} left: {album.missing_tracks.slice(0, 3).join(', ')}
          {album.missing_tracks.length > 3 ? ' …' : ''}
        </Text>
      </View>
      <View style={styles.readout}>
        <Text style={[styles.pct, { color: accent }]}>
          {Math.round(album.completion * 100)}
          <Text style={styles.pctSign}>%</Text>
        </Text>
        <Text style={styles.ratio}>
          {album.played_tracks}/{album.total_tracks}
        </Text>
      </View>
    </Pressable>
  );
}

export default function AlmostThereScreen({ onBack }: { onBack: () => void }) {
  const collection = useMemo(loadCollection, []);
  const list = useMemo(() => almostThere(collection), [collection]);
  const [selected, setSelected] = useState<Album | null>(null);

  const renderItem = useCallback(
    ({ item }: { item: Album }) => <AlmostThereRow album={item} onOpen={setSelected} />,
    []
  );

  return (
    <View style={styles.room}>
      {/* A FlatList, not a ScrollView: the list runs to hundreds of albums and
          every bar is animated, so only the rows actually on screen should be
          mounted (and therefore animating) at any moment. */}
      <FlatList
        data={list}
        // A handful of ids repeat in collection.json (MusicBrainz release-group
        // ids shared by collaborators, e.g. the Samurai Champloo records), so
        // the id alone is not a unique key and React drops rows.
        keyExtractor={(a, i) => a.id + '#' + i}
        renderItem={renderItem}
        ListHeaderComponent={
          <TopBar
            title="ALMOST THERE"
            subtitle="One more listen and these go on the shelf"
            onBack={onBack}
          />
        }
        ListEmptyComponent={<Text style={styles.empty}>Nothing in progress. Go dig.</Text>}
        contentContainerStyle={styles.content}
        initialNumToRender={8}
        windowSize={7}
        removeClippedSubviews={Platform.OS !== 'web'}
      />
      {selected && <AlbumDetail album={selected} onClose={() => setSelected(null)} />}
    </View>
  );
}

const styles = StyleSheet.create({
  room: { flex: 1, backgroundColor: theme.room },
  content: { paddingBottom: 48, maxWidth: 560, width: '100%', alignSelf: 'center' },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginHorizontal: 18,
    marginBottom: 10,
    backgroundColor: theme.card,
    borderWidth: 1,
    borderColor: theme.cardEdge,
    borderRadius: 12,
    padding: 12,
  },
  info: { flex: 1 },
  title: { color: theme.ink, fontSize: 15, fontWeight: '800' },
  artist: { color: theme.inkDim, fontSize: 12, marginTop: 1 },
  missing: { color: theme.inkFaint, fontSize: 11, marginTop: 7, lineHeight: 15 },
  readout: { alignItems: 'flex-end', minWidth: 46 },
  pct: { fontSize: 19, fontWeight: '900', letterSpacing: -0.5 },
  pctSign: { fontSize: 11, fontWeight: '800' },
  ratio: {
    color: theme.inkFaint,
    fontSize: 10,
    marginTop: 2,
    letterSpacing: 0.5,
    fontVariant: ['tabular-nums'],
  },
  empty: { color: theme.inkDim, textAlign: 'center', marginTop: 40 },
});
