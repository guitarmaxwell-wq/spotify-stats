/**
 * One sticker: the reward's art if it has some, otherwise a generated
 * placeholder that is stable per reward (same hash palette as record sleeves).
 *
 * SVG art is shown only on web: React Native's Image cannot decode SVG, and a
 * blank white disc is worse than the placeholder.
 */

import React, { useState } from 'react';
import { Image, Platform, StyleSheet, Text, View } from 'react-native';

import { hashId, sleevePalette } from '../theme';

interface Props {
  rewardId: string;
  name: string;
  artUrl: string | null;
  size: number;
  /** Tilt it a little, like a sticker slapped on by hand. */
  tilt?: boolean;
}

export default function Sticker({ rewardId, name, artUrl, size, tilt = true }: Props) {
  const [broken, setBroken] = useState(false);
  const p = sleevePalette(rewardId);
  const angle = tilt ? ((hashId(rewardId) % 13) - 6) : 0;
  const isSvg = Boolean(artUrl && /\.svg($|\?)/i.test(artUrl));
  const showArt = Boolean(artUrl) && !broken && (Platform.OS === 'web' || !isSvg);

  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');

  return (
    <View
      style={[
        styles.disc,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: Math.max(3, size * 0.05),
          backgroundColor: p.base,
          transform: [{ rotate: `${angle}deg` }],
        },
      ]}
      accessibilityLabel={`${name} sticker`}
    >
      {showArt ? (
        <Image
          source={{ uri: artUrl! }}
          style={{ width: '100%', height: '100%' }}
          resizeMode="cover"
          onError={() => setBroken(true)}
        />
      ) : (
        <View style={[styles.inner, { backgroundColor: p.deep, borderColor: p.accent }]}>
          <Text style={[styles.initials, { color: p.text, fontSize: size * 0.3 }]}>{initials}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  disc: {
    borderColor: '#f7f1e6',
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    // boxShadow, not shadow*: the shadow* props are dropped on web in SDK 57.
    boxShadow: '0 4px 10px rgba(0,0,0,0.45)',
  },
  inner: {
    width: '78%',
    height: '78%',
    borderRadius: 999,
    borderWidth: 2,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
  },
  initials: { fontWeight: '900', letterSpacing: 1 },
});
