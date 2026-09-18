import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { theme } from '../theme';

export default function TopBar({
  title,
  subtitle,
  onBack,
}: {
  title: string;
  subtitle?: string;
  onBack: () => void;
}) {
  return (
    <View style={styles.bar}>
      <Pressable onPress={onBack} style={styles.back} hitSlop={10}>
        <Text style={styles.backText}>‹ Shelf</Text>
      </Pressable>
      <Text style={styles.title}>{title}</Text>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { paddingHorizontal: 18, paddingTop: 14, paddingBottom: 10 },
  back: { alignSelf: 'flex-start', paddingVertical: 4, paddingRight: 8 },
  backText: { color: theme.gold, fontSize: 14, fontWeight: '700' },
  title: { color: theme.ink, fontSize: 24, fontWeight: '900', letterSpacing: 2, marginTop: 6 },
  subtitle: { color: theme.inkDim, fontSize: 13, marginTop: 3 },
});
