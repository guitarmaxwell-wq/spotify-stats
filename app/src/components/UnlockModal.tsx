/**
 * The payoff. A swipeable stack of records, used for two occasions:
 *
 *  - `welcome` — first launch, flipping through the shelf you arrive with.
 *    Potentially hundreds of cards, so the list is virtualized and the user can
 *    leave at any point. It is a gallery, not a gate.
 *  - `new` — a record finished while you were away. Usually one card.
 *
 * Both are the same gesture: swipe sideways, like flicking through a crate.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
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
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  useReducedMotion,
} from 'react-native-reanimated';

import RecordSleeve from './RecordSleeve';
import { theme } from '../theme';
import { albumColors } from './ProgressGradientBar';
import type { Unlock, UnlockMode } from '../link/unlockWatch';

interface Props {
  batch: { mode: UnlockMode; items: Unlock[] };
  onClose: () => void;
}

export default function UnlockModal({ batch, onClose }: Props) {
  const { items, mode } = batch;
  const { width } = useWindowDimensions();
  const [index, setIndex] = useState(0);
  const listRef = useRef<FlatList<Unlock>>(null);

  // Card width drives paging. Capped so the sleeve does not become absurd on a
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
          <Text style={styles.kicker}>
            {mode === 'welcome' ? 'YOUR SHELF SO FAR' : many ? 'NEW RECORDS' : 'NEW RECORD'}
          </Text>
          <Text style={styles.count}>
            {mode === 'welcome'
              ? `${items.length.toLocaleString()} records already earned`
              : many
                ? `${items.length} finished while you were away`
                : 'Finished while you were away'}
          </Text>
        </View>

        <FlatList
          ref={listRef}
          data={items}
          keyExtractor={(u, i) => `${u.album.id}#${i}`}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          snapToInterval={page}
          decelerationRate="fast"
          onScroll={onScroll}
          scrollEventThrottle={16}
          // Width is pinned to one page, otherwise the list spans the whole
          // backdrop and the neighbouring records show either side of the one
          // being looked at.
          style={{ flexGrow: 0, width: page }}
          // Hundreds of cards on first run: keep only a few realized.
          initialNumToRender={2}
          maxToRenderPerBatch={3}
          windowSize={3}
          removeClippedSubviews
          getItemLayout={(_, i) => ({ length: page, offset: page * i, index: i })}
          renderItem={({ item, index: i }) => (
            <UnlockCard unlock={item} width={page} active={i === index} mode={mode} />
          )}
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
              <Text style={styles.buttonText}>
                {mode === 'welcome' ? 'Go to the shelf' : last ? 'Put it on the shelf' : 'Done'}
              </Text>
            </Pressable>
          </View>
          {many && <Text style={styles.hint}>Swipe to flip through</Text>}
        </View>
      </View>
    </Modal>
  );
}

const SLEEVE = 180;

function UnlockCard({
  unlock,
  width,
  active,
  mode,
}: {
  unlock: Unlock;
  width: number;
  active: boolean;
  mode: UnlockMode;
}) {
  const { album, completedBy } = unlock;
  const reduceMotion = useReducedMotion();
  const lift = useSharedValue(reduceMotion ? 1 : 0);

  // The sleeve settles when its card becomes the active one. One spring, not a
  // bounce: it should read as a heavy object coming to rest.
  React.useEffect(() => {
    if (reduceMotion) {
      lift.value = 1;
      return;
    }
    lift.value = withSpring(active ? 1 : 0.92, { damping: 15, stiffness: 120, mass: 0.9 });
  }, [active, reduceMotion, lift]);

  const sleeveStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 0.9 + lift.value * 0.1 }],
    opacity: 0.55 + lift.value * 0.45,
  }));

  const colors = useMemo(() => albumColors(album), [album]);

  // Deliberately not shown: which track completed the album. On a record played
  // start to finish it is always the last track, so naming it reads as an
  // insight while carrying no information.
  const earnedOn = album.unlocked_at
    ? new Date(album.unlocked_at).toLocaleDateString(undefined, {
        month: 'short',
        year: 'numeric',
      })
    : null;

  return (
    <View style={[styles.card, { width }]}>
      <Animated.View style={sleeveStyle}>
        <RecordSleeve album={album} size={SLEEVE} showLock={false} />
      </Animated.View>

      <Text style={styles.artist} numberOfLines={1}>
        {album.artist.toUpperCase()}
      </Text>
      <Text style={styles.title} numberOfLines={2}>
        {album.title}
      </Text>

      <LinearGradient
        colors={[colors.primary, colors.secondary]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={styles.rule}
      />

      <Text style={styles.body}>
        {completedBy ? (
          <>
            All <Text style={styles.strong}>{album.total_tracks}</Text> tracks played
          </>
        ) : (
          <>
            All {album.total_tracks} tracks · {album.play_count.toLocaleString()} plays
            {mode === 'welcome' && earnedOn ? ` · earned ${earnedOn}` : ''}
          </>
        )}
      </Text>
    </View>
  );
}

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
  card: {
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingHorizontal: 22,
    paddingTop: 14,
  },
  artist: {
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
