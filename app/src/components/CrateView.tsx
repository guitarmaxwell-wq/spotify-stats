import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Crate } from '../types';
import { sleevePalette, theme } from '../theme';
import RecordSleeve from './RecordSleeve';

interface Props {
  crate: Crate;
  width: number;
  onPress: () => void;
}

const EDGE_H = 5;
const MAX_EDGES = 7;

/**
 * One milk crate on a shelf. The front record faces out; behind it you see the
 * top edges of the records filed behind it.
 */
export default function CrateView({ crate, width, onPress }: Props) {
  const front = crate.albums[0];
  const behind = crate.albums.slice(1, 1 + MAX_EDGES);
  const inset = width * 0.075;
  const sleeveSize = width - inset * 2;
  const edgeStackH = behind.length * EDGE_H + 4;
  const crateH = edgeStackH + sleeveSize * 0.95;

  return (
    <Pressable onPress={onPress} style={({ pressed }) => [{ width }, pressed && styles.pressed]}>
      <View style={{ height: crateH }}>
        {/* crate shell (back + side walls) */}
        <View style={[styles.shell, { top: edgeStackH * 0.45 }]} />
        <View style={[styles.shellInner, { top: edgeStackH * 0.45 + 3 }]} />

        {/* records filed front-to-back: edges of the ones behind */}
        {behind
          .map((album, i) => {
            const pal = sleevePalette(album.id);
            const depth = behind.length - i;
            return (
              <View
                key={`${album.id}#${i}`}
                style={[
                  styles.edge,
                  {
                    top: edgeStackH - depth * EDGE_H,
                    left: inset + depth * 1.6,
                    right: inset + depth * 1.6,
                    height: EDGE_H + 3,
                    backgroundColor: album.unlocked ? pal.deep : '#2b2520',
                    opacity: 1 - depth * 0.06,
                  },
                ]}
              />
            );
          })
          .reverse()}

        {/* the front record */}
        <View style={{ position: 'absolute', top: edgeStackH, left: inset }}>
          <RecordSleeve album={front} size={sleeveSize} />
        </View>

        {/* front panel of the crate, overlapping the lower half of the records */}
        <View style={[styles.front, { height: sleeveSize * 0.44 }]}>
          <View style={styles.slatRow}>
            {[0, 1, 2, 3].map((i) => (
              <View key={i} style={styles.slatGap} />
            ))}
          </View>
          <View style={styles.label}>
            <Text numberOfLines={1} style={styles.labelText}>
              {crate.genre.label.toUpperCase()}
            </Text>
            <Text style={styles.labelCount}>
              {crate.albums.length}
            </Text>
          </View>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.86, transform: [{ translateY: 1 }] },
  shell: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: theme.crateDark,
    borderRadius: 6,
  },
  shellInner: {
    position: 'absolute',
    left: 3,
    right: 3,
    bottom: 4,
    backgroundColor: '#16302b',
    borderRadius: 4,
  },
  edge: {
    position: 'absolute',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.22)',
    borderRadius: 2,
  },
  front: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: theme.crate,
    borderRadius: 6,
    borderTopWidth: 2,
    borderTopColor: theme.crateLight,
    borderBottomWidth: 3,
    borderBottomColor: theme.crateDark,
    overflow: 'hidden',
    justifyContent: 'space-between',
    paddingTop: 6,
  },
  slatRow: { flexDirection: 'row', justifyContent: 'space-evenly', paddingHorizontal: 8 },
  slatGap: {
    width: 10,
    height: 16,
    borderRadius: 2,
    backgroundColor: 'rgba(0,0,0,0.30)',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.18)',
  },
  label: {
    backgroundColor: '#efe6d2',
    marginHorizontal: 10,
    marginBottom: 8,
    paddingVertical: 3,
    paddingHorizontal: 6,
    borderRadius: 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  labelText: {
    color: '#2b1d12',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1,
    flexShrink: 1,
  },
  labelCount: { color: '#7a6247', fontSize: 9, fontWeight: '700', marginLeft: 6 },
});
