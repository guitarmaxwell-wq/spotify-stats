import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import RecordSleeve from '../components/RecordSleeve';
import AlbumDetail from '../components/AlbumDetail';
import TopBar from '../components/TopBar';
import { almostThere, loadCollection } from '../data/collection';
import { theme } from '../theme';
import type { Album } from '../types';

export default function AlmostThereScreen({ onBack }: { onBack: () => void }) {
  const collection = useMemo(loadCollection, []);
  const list = useMemo(() => almostThere(collection), [collection]);
  const [selected, setSelected] = useState<Album | null>(null);

  return (
    <ScrollView style={styles.room} contentContainerStyle={{ paddingBottom: 48 }}>
      <TopBar
        title="ALMOST THERE"
        subtitle="One more listen and these go on the shelf"
        onBack={onBack}
      />
      <View style={styles.body}>
        {list.map((album) => {
          const missing = album.total_tracks - album.played_tracks;
          return (
            <Pressable key={album.id} style={styles.card} onPress={() => setSelected(album)}>
              <RecordSleeve album={album} size={74} showLock={false} />
              <View style={styles.info}>
                <Text style={styles.title} numberOfLines={1}>
                  {album.title}
                </Text>
                <Text style={styles.artist} numberOfLines={1}>
                  {album.artist}
                </Text>
                <View style={styles.barTrack}>
                  <View style={[styles.barFill, { width: `${Math.round(album.completion * 100)}%` }]} />
                </View>
                <Text style={styles.missing} numberOfLines={2}>
                  {missing} left: {album.missing_tracks.slice(0, 3).join(', ')}
                  {album.missing_tracks.length > 3 ? ' …' : ''}
                </Text>
              </View>
              <Text style={styles.pct}>{Math.round(album.completion * 100)}%</Text>
            </Pressable>
          );
        })}
        {list.length === 0 && <Text style={styles.empty}>Nothing in progress. Go dig.</Text>}
      </View>
      {selected && <AlbumDetail album={selected} onClose={() => setSelected(null)} />}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  room: { flex: 1, backgroundColor: theme.room },
  body: { paddingHorizontal: 18, maxWidth: 560, width: '100%', alignSelf: 'center', gap: 10 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    backgroundColor: theme.card,
    borderWidth: 1,
    borderColor: theme.cardEdge,
    borderRadius: 12,
    padding: 12,
  },
  info: { flex: 1 },
  title: { color: theme.ink, fontSize: 15, fontWeight: '800' },
  artist: { color: theme.inkDim, fontSize: 12, marginTop: 1 },
  barTrack: {
    marginTop: 8,
    height: 5,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.12)',
    overflow: 'hidden',
  },
  barFill: { height: 5, backgroundColor: theme.gold },
  missing: { color: theme.inkFaint, fontSize: 11, marginTop: 6, lineHeight: 15 },
  pct: { color: theme.gold, fontSize: 15, fontWeight: '900' },
  empty: { color: theme.inkDim, textAlign: 'center', marginTop: 40 },
});
