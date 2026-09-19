/**
 * Newly granted stickers, celebrated in the same deck as newly finished records
 * (CelebrationDeck), so a sticker feels like part of the same shelf rather than
 * a notification from somewhere else.
 */

import React from 'react';
import { Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import CelebrationDeck, { cardText as styles } from './CelebrationDeck';
import Sticker from './Sticker';
import { theme } from '../theme';
import type { StickerBatch } from '../rewards/stickerSeen';
import type { EarnedReward } from '../rewards/types';
import { earnedLine } from './stickerText';

export default function StickerUnlockModal({
  batch,
  onClose,
}: {
  batch: StickerBatch;
  onClose: () => void;
}) {
  const { items, mode } = batch;
  const many = items.length > 1;
  return (
    <CelebrationDeck
      items={items}
      keyOf={(r) => r.key}
      renderCard={(item, { width, active }) => <StickerCard reward={item} width={width} active={active} />}
      kicker={mode === 'welcome' && many ? 'YOUR STICKERS SO FAR' : many ? 'NEW STICKERS' : 'NEW STICKER'}
      count={
        many
          ? `${items.length} earned by listening`
          : 'Earned by listening'
      }
      closeLabel={(last) => (last ? 'Keep it' : 'Done')}
      onClose={onClose}
    />
  );
}

function StickerCard({ reward, width, active }: { reward: EarnedReward; width: number; active: boolean }) {
  const reduceMotion = useReducedMotion();
  const lift = useSharedValue(reduceMotion ? 1 : 0);

  // Stickers land with a little more snap than a record sleeve: lighter object.
  React.useEffect(() => {
    if (reduceMotion) {
      lift.value = 1;
      return;
    }
    lift.value = withSpring(active ? 1 : 0.9, { damping: 11, stiffness: 160, mass: 0.6 });
  }, [active, reduceMotion, lift]);

  const style = useAnimatedStyle(() => ({
    transform: [{ scale: 0.8 + lift.value * 0.2 }],
    opacity: 0.5 + lift.value * 0.5,
  }));

  return (
    <View style={[styles.card, { width }]}>
      <Animated.View style={style}>
        <Sticker rewardId={reward.rewardId} name={reward.name} artUrl={reward.artUrl} size={170} />
      </Animated.View>

      {reward.subjectName ? (
        <Text style={styles.over} numberOfLines={1}>
          {reward.subjectName.toUpperCase()}
        </Text>
      ) : (
        <View style={{ height: 20 }} />
      )}
      <Text style={styles.title} numberOfLines={2}>
        {reward.name}
      </Text>
      <View style={[styles.rule, { backgroundColor: theme.gold }]} />
      <Text style={styles.body}>{earnedLine(reward)}</Text>
    </View>
  );
}
