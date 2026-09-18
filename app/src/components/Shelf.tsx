import React from 'react';
import { StyleSheet, View } from 'react-native';
import { theme } from '../theme';

/** A wooden plank with a visible front edge; crates sit on top of it. */
export default function Shelf({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.wrap}>
      <View style={styles.contents}>{children}</View>
      <View style={styles.plankTop}>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <View key={i} style={[styles.grain, { left: `${6 + i * 15}%`, width: `${5 + (i % 3) * 4}%` }]} />
        ))}
      </View>
      <View style={styles.plankFace} />
      <View style={styles.plankShadow} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 22 },
  contents: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
  },
  plankTop: {
    height: 9,
    backgroundColor: theme.woodLight,
    borderTopWidth: 1,
    borderTopColor: '#a7743f',
    overflow: 'hidden',
  },
  grain: {
    position: 'absolute',
    top: 3,
    height: 2,
    borderRadius: 2,
    backgroundColor: 'rgba(60,34,14,0.35)',
  },
  plankFace: {
    height: 16,
    backgroundColor: theme.wood,
    borderBottomWidth: 4,
    borderBottomColor: theme.woodDark,
  },
  plankShadow: {
    height: 14,
    backgroundColor: 'rgba(0,0,0,0.38)',
    borderBottomLeftRadius: 40,
    borderBottomRightRadius: 40,
    marginHorizontal: 6,
  },
});
