import { StatusBar } from 'expo-status-bar';
import React, { useState } from 'react';
import { SafeAreaView, StyleSheet } from 'react-native';
import ShelfScreen from './src/screens/ShelfScreen';
import CrateDetailScreen from './src/screens/CrateDetailScreen';
import StatsScreen from './src/screens/StatsScreen';
import AlmostThereScreen from './src/screens/AlmostThereScreen';
import LinkScreen from './src/screens/LinkScreen';
import StickersScreen from './src/screens/StickersScreen';
import UnlockModal from './src/components/UnlockModal';
import StickerUnlockModal from './src/components/StickerUnlockModal';
import { useUnlockQueue } from './src/hooks/useUnlockQueue';
import { RewardsProvider, useRewards } from './src/rewards';
import { theme } from './src/theme';
import type { Crate } from './src/types';

type Route =
  | { name: 'shelf' }
  | { name: 'crate'; crate: Crate }
  | { name: 'stats' }
  | { name: 'almost' }
  | { name: 'link' }
  | { name: 'stickers' };

export default function App() {
  return (
    <RewardsProvider>
      <Milk />
    </RewardsProvider>
  );
}

function Milk() {
  const [route, setRoute] = useState<Route>({ name: 'shelf' });
  const back = () => setRoute({ name: 'shelf' });
  const unlocks = useUnlockQueue();
  const { stickerBatch, closeStickers } = useRewards();

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="light" />
      {route.name === 'shelf' && (
        <ShelfScreen
          onOpenCrate={(crate) => setRoute({ name: 'crate', crate })}
          onOpenStats={() => setRoute({ name: 'stats' })}
          onOpenAlmost={() => setRoute({ name: 'almost' })}
          onOpenLink={() => setRoute({ name: 'link' })}
          onOpenStickers={() => setRoute({ name: 'stickers' })}
        />
      )}
      {route.name === 'crate' && <CrateDetailScreen crate={route.crate} onBack={back} />}
      {route.name === 'stats' && <StatsScreen onBack={back} />}
      {route.name === 'almost' && <AlmostThereScreen onBack={back} />}
      {route.name === 'link' && <LinkScreen onBack={back} />}
      {route.name === 'stickers' && (
        <StickersScreen onBack={back} onOpenLink={() => setRoute({ name: 'link' })} />
      )}
      {unlocks.showing && unlocks.batch && (
        <UnlockModal batch={unlocks.batch} onClose={unlocks.close} />
      )}
      {/* One celebration at a time: records first, then any new stickers. */}
      {!unlocks.showing && stickerBatch && stickerBatch.items.length > 0 && (
        <StickerUnlockModal batch={stickerBatch} onClose={closeStickers} />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.room },
});
