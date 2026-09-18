import React, { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import CrateView from '../components/CrateView';
import Shelf from '../components/Shelf';
import { buildCrates, loadCollection } from '../data/collection';
import { theme } from '../theme';
import type { Crate } from '../types';

interface Props {
  onOpenCrate: (crate: Crate) => void;
  onOpenStats: () => void;
  onOpenAlmost: () => void;
  onOpenLink: () => void;
}

export default function ShelfScreen({ onOpenCrate, onOpenStats, onOpenAlmost, onOpenLink }: Props) {
  const collection = useMemo(loadCollection, []);
  const crates = useMemo(() => buildCrates(collection), [collection]);
  const { width } = useWindowDimensions();

  const maxContent = Math.min(width, 560);
  const perShelf = maxContent > 460 ? 3 : 2;
  const crateWidth = Math.floor((maxContent - 36 - (perShelf - 1) * 14) / perShelf);

  const rows: Crate[][] = [];
  for (let i = 0; i < crates.length; i += perShelf) rows.push(crates.slice(i, i + perShelf));

  return (
    <ScrollView style={styles.room} contentContainerStyle={{ paddingBottom: 48 }}>
      <View style={{ width: maxContent, alignSelf: 'center' }}>
        <View style={styles.header}>
          <Text style={styles.title}>MILK</Text>
          <Text style={styles.subtitle}>
            {collection.stats.unlocked_count} records earned · {collection.stats.in_progress_count} still filling
          </Text>
          <View style={styles.buttons}>
            <Pressable style={styles.button} onPress={onOpenStats}>
              <Text style={styles.buttonText}>Stats</Text>
            </Pressable>
            <Pressable style={styles.button} onPress={onOpenAlmost}>
              <Text style={styles.buttonText}>Almost there</Text>
            </Pressable>
            <Pressable style={styles.button} onPress={onOpenLink}>
              <Text style={styles.buttonText}>Link history</Text>
            </Pressable>
          </View>
        </View>

        {rows.map((row, i) => (
          <Shelf key={i}>
            {row.map((crate) => (
              <CrateView
                key={crate.genre.id}
                crate={crate}
                width={crateWidth}
                onPress={() => onOpenCrate(crate)}
              />
            ))}
            {row.length < perShelf &&
              Array.from({ length: perShelf - row.length }).map((_, k) => (
                <View key={`pad${k}`} style={{ width: crateWidth }} />
              ))}
          </Shelf>
        ))}

        <Text style={styles.footer}>
          An album lands in a crate only once every track on it has been played.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  room: { flex: 1, backgroundColor: theme.room },
  header: { paddingHorizontal: 18, paddingTop: 18, paddingBottom: 22 },
  title: { color: theme.ink, fontSize: 30, fontWeight: '900', letterSpacing: 6 },
  subtitle: { color: theme.inkDim, fontSize: 13, marginTop: 4 },
  buttons: { flexDirection: 'row', gap: 10, marginTop: 14 },
  button: {
    backgroundColor: theme.card,
    borderWidth: 1,
    borderColor: theme.cardEdge,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 999,
  },
  buttonText: { color: theme.ink, fontWeight: '700', fontSize: 13 },
  footer: {
    color: theme.inkFaint,
    fontSize: 12,
    textAlign: 'center',
    paddingHorizontal: 40,
    marginTop: 6,
  },
});
