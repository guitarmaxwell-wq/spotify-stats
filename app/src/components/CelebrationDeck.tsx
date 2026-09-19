/**
 * The shared celebration shell: a dimmed backdrop, a kicker, a swipeable stack
 * of cards, and one clear way out. Records use it (UnlockModal) and so do
 * stickers (StickerUnlockModal), so there is exactly one celebration style in
 * the app.
 *
 * The gesture is the same everywhere: swipe sideways, like flicking through a
 * crate. It is a gallery, not a gate; the user can leave at any point.
 */

import React, { useCallback, useRef, useState } from 'react';
import {
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

import { theme } from '../theme';

interface Props<T> {
  items: T[];
  keyOf: (item: T, index: number) => string;
  renderCard: (item: T, info: { width: number; active: boolean }) => React.ReactElement;
  kicker: string;
  count: string;
  /** Label of the closing button, given whether the last card is showing. */
  closeLabel: (last: boolean) => string;
  onClose: () => void;
}

export default function CelebrationDeck<T>({
  items,
  keyOf,
  renderCard,
  kicker,
  count,
  closeLabel,
  onClose,
}: Props<T>) {
  const { width } = useWindowDimensions();
  const [index, setIndex] = useState(0);
  const listRef = useRef<FlatList<T>>(null);

  // Card width drives paging. Capped so a card does not become absurd on a
  // tablet or a wide browser window.
  const page = Math.min(width - 40, 380);

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const i = Math.round(e.nativeEvent.contentOffset.x / page);
      if (i !== index) setIndex(i);
    },
    [index, page]
  );

  const advance = useCallback(() => {
    if (index + 1 >= items.length) return onClose();
    listRef.current?.scrollToOffset({ offset: (index + 1) * page, animated: true });
  }, [index, items.length, page, onClose]);

  if (items.length === 0) return null;

  const many = items.length > 1;
  const last = index + 1 >= items.length;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={[styles.header, { width: page }]}>
          <Text style={styles.kicker}>{kicker}</Text>
          <Text style={styles.count}>{count}</Text>
        </View>

        <FlatList
          ref={listRef}
          data={items}
          keyExtractor={keyOf}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          snapToInterval={page}
          decelerationRate="fast"
          onScroll={onScroll}
          scrollEventThrottle={16}
          // Width is pinned to one page, otherwise the list spans the whole
          // backdrop and the neighbouring cards show either side of the one
          // being looked at.
          style={{ flexGrow: 0, width: page }}
          // Hundreds of cards on a first run: keep only a few realized.
          initialNumToRender={2}
          maxToRenderPerBatch={3}
          windowSize={3}
          removeClippedSubviews
          getItemLayout={(_, i) => ({ length: page, offset: page * i, index: i })}
          renderItem={({ item, index: i }) => renderCard(item, { width: page, active: i === index })}
        />

        <View style={[styles.footer, { width: page }]}>
          {many && (
            <Text style={styles.position}>
              {index + 1} / {items.length}
            </Text>
          )}
          <View style={styles.actions}>
            {many && !last && (
              <Pressable
                onPress={advance}
                style={({ pressed }) => [styles.ghost, pressed && styles.ghostPressed]}
              >
                <Text style={styles.ghostText}>Next</Text>
              </Pressable>
            )}
            <Pressable
              onPress={onClose}
              style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
            >
              <Text style={styles.buttonText}>{closeLabel(last)}</Text>
            </Pressable>
          </View>
          {many && <Text style={styles.hint}>Swipe to flip through</Text>}
        </View>
      </View>
    </Modal>
  );
}

/** Text styles shared by every card, so records and stickers read alike. */
export const cardText = StyleSheet.create({
  card: {
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingHorizontal: 22,
    paddingTop: 14,
  },
  over: {
    color: theme.inkDim,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 2,
    marginTop: 20,
    marginBottom: 6,
    textAlign: 'center',
  },
  title: {
    color: theme.ink,
    fontSize: 22,
    fontWeight: '800',
    textAlign: 'center',
    lineHeight: 27,
  },
  rule: { width: 84, height: 3, borderRadius: 2, marginTop: 12, marginBottom: 14 },
  body: { color: theme.inkDim, fontSize: 13, lineHeight: 20, textAlign: 'center' },
  strong: { color: theme.ink, fontWeight: '700' },
});

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(8,5,3,0.88)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 20,
  },
  header: { alignItems: 'center', marginBottom: 10 },
  kicker: { color: theme.gold, fontSize: 11, fontWeight: '800', letterSpacing: 2.4 },
  count: { color: theme.inkFaint, fontSize: 12, marginTop: 6 },
  footer: { alignItems: 'center', marginTop: 12 },
  position: { color: theme.inkFaint, fontSize: 12, marginBottom: 10, letterSpacing: 1 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  button: {
    backgroundColor: theme.crate,
    borderRadius: 999,
    paddingVertical: 12,
    paddingHorizontal: 26,
  },
  buttonPressed: { backgroundColor: theme.crateDark },
  buttonText: { color: theme.ink, fontWeight: '800', fontSize: 14 },
  ghost: {
    borderRadius: 999,
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderWidth: 1,
    borderColor: theme.cardEdge,
  },
  ghostPressed: { backgroundColor: theme.card },
  ghostText: { color: theme.inkDim, fontWeight: '700', fontSize: 14 },
  hint: { color: theme.inkFaint, fontSize: 11, marginTop: 12 },
});
