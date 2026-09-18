import React, { useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import RecordSleeve from '../components/RecordSleeve';
import TopBar from '../components/TopBar';
import AlbumDetail from '../components/AlbumDetail';
import { theme } from '../theme';
import type { Album, Crate } from '../types';

/** Flipping through an open crate: records filed front-to-back, edge-on. */
export default function CrateDetailScreen({ crate, onBack }: { crate: Crate; onBack: () => void }) {
  const { width, height } = useWindowDimensions();
  const [selected, setSelected] = useState<Album | null>(null);
  const [focus, setFocus] = useState(0);

  const sleeve = Math.min(width * 0.56, height * 0.38, 300);
  const step = sleeve * 0.36; // how much of each record behind stays visible
  const focused = crate.albums[focus];

  return (
    <View style={styles.room}>
      <TopBar
        title={crate.genre.label}
        subtitle={`${crate.albums.length} records · ${crate.unlockedCount} earned`}
        onBack={onBack}
      />

      <View style={styles.stage}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{
            paddingLeft: 24,
            paddingRight: 24 + sleeve,
            alignItems: 'center',
            paddingVertical: 20,
          }}
        >
          {crate.albums.map((album, i) => {
            const isFocus = i === focus;
            return (
              <Pressable
                key={`${album.id}#${i}`}
                onPress={() => (isFocus ? setSelected(album) : setFocus(i))}
                style={{
                  width: step,
                  zIndex: crate.albums.length - i,
                  transform: [
                    { perspective: 700 },
                    { rotateY: isFocus ? '0deg' : '-52deg' },
                    { translateY: isFocus ? -14 : 0 },
                  ],
                }}
              >
                <View style={styles.shadowWrap}>
                  <RecordSleeve album={album} size={sleeve} />
                </View>
              </Pressable>
            );
          })}
        </ScrollView>

        <View style={styles.rail} />
      </View>

      {focused && (
        <View style={styles.nowplate}>
          <Text style={styles.nowArtist}>{focused.artist.toUpperCase()}</Text>
          <Text style={styles.nowTitle} numberOfLines={2}>
            {focused.title}
          </Text>
          <Text style={styles.nowMeta}>
            {focused.unlocked
              ? `Earned · ${focused.play_count} plays`
              : `${focused.played_tracks} of ${focused.total_tracks} tracks · ${focused.total_tracks - focused.played_tracks} to go`}
          </Text>
          <Pressable style={styles.openBtn} onPress={() => setSelected(focused)}>
            <Text style={styles.openBtnText}>Pull it out</Text>
          </Pressable>
        </View>
      )}

      {selected && <AlbumDetail album={selected} onClose={() => setSelected(null)} />}
    </View>
  );
}

const styles = StyleSheet.create({
  room: { flex: 1, backgroundColor: theme.room },
  stage: { backgroundColor: theme.roomDeep, borderTopWidth: 1, borderTopColor: '#2c2119' },
  rail: { height: 10, backgroundColor: theme.wood, borderBottomWidth: 4, borderBottomColor: theme.woodDark },
  shadowWrap: {
    shadowColor: '#000',
    shadowOpacity: 0.55,
    shadowRadius: 10,
    shadowOffset: { width: -6, height: 6 },
  },
  nowplate: { padding: 20 },
  nowArtist: { color: theme.gold, fontSize: 12, fontWeight: '800', letterSpacing: 2 },
  nowTitle: { color: theme.ink, fontSize: 22, fontWeight: '800', marginTop: 4 },
  nowMeta: { color: theme.inkDim, fontSize: 13, marginTop: 6 },
  openBtn: {
    marginTop: 14,
    alignSelf: 'flex-start',
    backgroundColor: theme.card,
    borderWidth: 1,
    borderColor: theme.cardEdge,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 999,
  },
  openBtnText: { color: theme.ink, fontWeight: '700' },
});
