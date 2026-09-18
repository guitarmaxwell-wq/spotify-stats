import React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import RecordSleeve from './RecordSleeve';
import { theme } from '../theme';
import type { Album } from '../types';

export default function AlbumDetail({ album, onClose }: { album: Album; onClose: () => void }) {
  const { width } = useWindowDimensions();
  const size = Math.min(width * 0.7, 300);
  const missing = album.total_tracks - album.played_tracks;

  return (
    <Modal transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.grabber} />
        <ScrollView contentContainerStyle={{ padding: 22, paddingBottom: 40 }}>
          <View style={{ alignSelf: 'center' }}>
            <RecordSleeve album={album} size={size} showLock={false} />
          </View>
          <Text style={styles.artist}>{album.artist.toUpperCase()}</Text>
          <Text style={styles.title}>{album.title}</Text>
          <Text style={styles.meta}>
            {[album.release_year, `${album.total_tracks} tracks`, `${album.play_count} plays`]
              .filter(Boolean)
              .join('  |  ')}
          </Text>

          {album.unlocked ? (
            <View style={[styles.badge, { borderColor: theme.gold }]}>
              <Text style={[styles.badgeText, { color: theme.gold }]}>
                EARNED{album.unlocked_at ? `  |  ${album.unlocked_at.slice(0, 10)}` : ''}
              </Text>
            </View>
          ) : (
            <>
              <View style={styles.barTrack}>
                <View style={[styles.barFill, { width: `${Math.round(album.completion * 100)}%` }]} />
              </View>
              <Text style={styles.progressText}>
                {album.played_tracks} of {album.total_tracks} played - {missing} track
                {missing === 1 ? '' : 's'} left
              </Text>
              {album.missing_tracks.length > 0 && (
                <View style={styles.missingBox}>
                  <Text style={styles.missingHead}>STILL MISSING</Text>
                  {album.missing_tracks.map((t, i) => (
                    <Text key={`${t}-${i}`} style={styles.missingItem}>
                      {t}
                    </Text>
                  ))}
                </View>
              )}
            </>
          )}

          <Text style={styles.source}>
            source: {album.source} / id: {album.id}
          </Text>

          <Pressable style={styles.close} onPress={onClose}>
            <Text style={styles.closeText}>Put it back</Text>
          </Pressable>
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.6)' },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    top: '8%',
    backgroundColor: theme.card,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderWidth: 1,
    borderColor: theme.cardEdge,
  },
  grabber: {
    width: 42,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.inkFaint,
    alignSelf: 'center',
    marginTop: 8,
  },
  artist: { color: theme.gold, fontSize: 12, fontWeight: '800', letterSpacing: 2, marginTop: 18 },
  title: { color: theme.ink, fontSize: 24, fontWeight: '900', marginTop: 4 },
  meta: { color: theme.inkDim, fontSize: 13, marginTop: 6 },
  badge: {
    marginTop: 16,
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 6,
    paddingHorizontal: 14,
  },
  badgeText: { fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  barTrack: {
    marginTop: 18,
    height: 6,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.12)',
    overflow: 'hidden',
  },
  barFill: { height: 6, backgroundColor: theme.gold },
  progressText: { color: theme.ink, fontSize: 14, marginTop: 8, fontWeight: '600' },
  missingBox: {
    marginTop: 16,
    padding: 14,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.30)',
    borderWidth: 1,
    borderColor: theme.cardEdge,
  },
  missingHead: { color: theme.inkFaint, fontSize: 10, fontWeight: '800', letterSpacing: 1.5, marginBottom: 8 },
  missingItem: { color: theme.ink, fontSize: 14, lineHeight: 21 },
  source: { color: theme.inkFaint, fontSize: 11, marginTop: 20 },
  close: {
    marginTop: 18,
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: theme.cardEdge,
    paddingVertical: 9,
    paddingHorizontal: 18,
    borderRadius: 999,
  },
  closeText: { color: theme.ink, fontWeight: '700' },
});
