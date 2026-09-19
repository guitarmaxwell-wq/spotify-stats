/**
 * The payoff. A swipeable stack of records, used for two occasions:
 *
 *  - `welcome` — first launch, flipping through the shelf you arrive with.
 *    Potentially hundreds of cards, so the list is virtualized and the user can
 *    leave at any point. It is a gallery, not a gate.
 *  - `new` — a record finished while you were away. Usually one card.
 *
 * Both are the same gesture: swipe sideways, like flicking through a crate.
 * The shell (backdrop, paging, buttons) is CelebrationDeck, shared with the
 * sticker celebration so the app has one celebration style.
 */

import React, { useMemo } from 'react';
import { Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  useReducedMotion,
} from 'react-native-reanimated';

import CelebrationDeck, { cardText as styles } from './CelebrationDeck';
import RecordSleeve from './RecordSleeve';
import { albumColors } from './ProgressGradientBar';
import type { Unlock, UnlockMode } from '../link/unlockWatch';

interface Props {
  batch: { mode: UnlockMode; items: Unlock[] };
  onClose: () => void;
}

export default function UnlockModal({ batch, onClose }: Props) {
  const { items, mode } = batch;
  const many = items.length > 1;

  return (
    <CelebrationDeck
      items={items}
      keyOf={(u, i) => `${u.album.id}#${i}`}
      renderCard={(item, { width, active }) => (
        <UnlockCard unlock={item} width={width} active={active} mode={mode} />
      )}
      kicker={mode === 'welcome' ? 'YOUR SHELF SO FAR' : many ? 'NEW RECORDS' : 'NEW RECORD'}
      count={
        mode === 'welcome'
          ? `${items.length.toLocaleString()} records already earned`
          : many
            ? `${items.length} finished while you were away`
            : 'Finished while you were away'
      }
      closeLabel={(last) =>
        mode === 'welcome' ? 'Go to the shelf' : last ? 'Put it on the shelf' : 'Done'
      }
      onClose={onClose}
    />
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

      <Text style={styles.over} numberOfLines={1}>
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
