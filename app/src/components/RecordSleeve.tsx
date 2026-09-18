import React, { useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import type { Album } from '../types';
import { sleevePalette, hashId, theme } from '../theme';

interface Props {
  album: Album;
  size: number;
  /** Show the "not unlocked yet" treatment (dim + completion band). */
  showLock?: boolean;
}

/**
 * A record sleeve. Uses cover_url when present and loadable; otherwise it draws
 * a typographic sleeve derived from the album id, which is the common case.
 */
export default function RecordSleeve({ album, size, showLock = true }: Props) {
  const [failed, setFailed] = useState(false);
  const pal = sleevePalette(album.id);
  const h = hashId(album.id);
  const layout = h % 3; // three sleeve layouts, so a shelf doesn't look cloned
  const locked = showLock && !album.unlocked;

  // The drawn sleeve is ALWAYS rendered; a real cover is layered on top of it.
  // A 404 or slow load therefore shows the drawn sleeve rather than a hole.
  const body = (
      <View style={[styles.sleeve, { width: size, height: size, backgroundColor: pal.base }]}>
        <View
          style={[
            styles.band,
            layout === 0 && { top: size * 0.16, height: size * 0.055 },
            layout === 1 && { top: size * 0.72, height: size * 0.035 },
            layout === 2 && { top: 0, height: size * 0.3, opacity: 0.35 },
            { backgroundColor: pal.accent },
          ]}
        />
        <View style={[styles.inner, { padding: size * 0.09 }]}>
          <Text
            numberOfLines={2}
            style={{
              color: pal.accent,
              fontSize: Math.max(7, size * 0.068),
              letterSpacing: Math.max(0.5, size * 0.012),
              fontWeight: '700',
              textTransform: 'uppercase',
            }}
          >
            {album.artist}
          </Text>
          <Text
            numberOfLines={3}
            style={{
              color: pal.text,
              fontSize: Math.max(9, size * 0.115),
              lineHeight: Math.max(11, size * 0.135),
              fontWeight: '800',
            }}
          >
            {album.title}
          </Text>
          <View style={[styles.rule, { backgroundColor: pal.accent, marginTop: size * 0.045 }]} />
          <View style={{ flex: 1 }} />
          {album.release_year != null && (
            <Text style={{ color: pal.text, opacity: 0.6, fontSize: Math.max(7, size * 0.06), marginTop: size * 0.03 }}>
              {album.release_year}
            </Text>
          )}
        </View>
      </View>
  );

  return (
    <View style={{ width: size, height: size }}>
      {body}
      {album.cover_url && !failed && (
        <Image
          source={{ uri: album.cover_url }}
          style={{ position: 'absolute', top: 0, left: 0, width: size, height: size }}
          onError={() => setFailed(true)}
        />
      )}
      {/* vinyl peeking out of the sleeve */}
      <View
        pointerEvents="none"
        style={[styles.vinyl, { right: -size * 0.035, top: size * 0.06, bottom: size * 0.06, width: size * 0.08 }]}
      />
      <View pointerEvents="none" style={styles.wear} />
      {locked && (
        <View pointerEvents="none" style={styles.lock}>
          <View style={styles.lockBarTrack}>
            <View style={[styles.lockBarFill, { width: `${Math.round(album.completion * 100)}%` }]} />
          </View>
          <Text style={[styles.lockText, { fontSize: Math.max(8, size * 0.075) }]}>
            {album.played_tracks}/{album.total_tracks}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  sleeve: { overflow: 'hidden', backgroundColor: '#333' },
  band: { position: 'absolute', left: 0, right: 0 },
  inner: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'flex-start' }, // title reads in the sleeve's exposed top half
  rule: { height: 2, width: '45%', opacity: 0.85 },
  vinyl: {
    position: 'absolute',
    backgroundColor: '#0c0c0c',
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#242424',
  },
  wear: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.55)',
    borderTopColor: 'rgba(255,255,255,0.10)',
    borderLeftColor: 'rgba(255,255,255,0.06)',
  },
  lock: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(8,6,4,0.58)',
    justifyContent: 'flex-end',
    padding: 6,
  },
  lockBarTrack: {
    height: 3,
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  lockBarFill: { height: 3, backgroundColor: theme.gold },
  lockText: { color: theme.ink, opacity: 0.85, marginTop: 4, fontWeight: '700' },
});

